# Codex authentication and transport Specification

## Purpose

Define the implemented trusted ChatGPT OAuth and OpenAI Codex adapter boundary
used by the provider-neutral harness. This imports the surviving Milestone 1
authentication contracts and Milestone 2 safe-answer delivery contract. These
operations are CLI infrastructure, not model-visible tools.

## Requirements

### Requirement: Browser OAuth login

`yo login` SHALL use the OpenAI browser authorization flow with fresh PKCE and
state values, an S256 challenge, and a loopback callback listener. The listener
SHALL be ready before the authorization URL is printed. The callback SHALL
validate state and require an authorization code before exchange. Failed callback
or exchange SHALL NOT persist a new credential, and the listener SHALL close
after completion or failure. No API-key fallback or device-code login SHALL be
provided.

#### Scenario: Valid login

- **WHEN** a callback carries the expected state and a code whose exchange succeeds
- **THEN** the trusted CLI persists the resulting OAuth credential

#### Scenario: Callback mismatch or occupied listener

- **WHEN** callback state is wrong or the loopback listener cannot start
- **THEN** login fails safely without storing credentials; a failed listener startup does not print an authorization URL

### Requirement: Restricted credential storage and commands

The production credential store SHALL use `~/.yo/auth.json`, enforce a regular
credential file with mode `0600` and parent directory mode `0700`, validate its
contents, and serialize modifications. Malformed credentials SHALL fail without
printing their contents. `yo auth status` SHALL report non-secret account and
expiry state or absence. `yo logout` SHALL remove the stored credential
idempotently. Credentials SHALL NOT be placed in tool definitions, conversation
messages, or terminal status.

#### Scenario: Missing credential status and logout

- **WHEN** no OAuth credential exists
- **THEN** status reports absence and logout succeeds without requiring a model request

### Requirement: Refresh before authenticated requests

Trusted infrastructure SHALL reuse an unexpired credential and refresh an
expired credential through the OAuth refresh grant. Concurrent refreshes SHALL
serialize and reuse the winner's persisted credential. A rotated credential
SHALL be persisted before use. Missing credentials SHALL require login without
sending a model request; failed refresh SHALL preserve the stored credential
and require login with a sanitized error, except trusted run cancellation,
which SHALL be classified as cancellation rather than an authentication failure.

#### Scenario: Concurrent expiry

- **WHEN** two requests encounter the same expired credential
- **THEN** refresh is serialized and the later request reuses the updated credential

### Requirement: Provider-neutral request and result conversion

The Codex adapter SHALL convert structured messages, tool calls, results, and
the requested closed tool definitions without losing observations. It SHALL
preserve explicit model selection and otherwise use its configured default.
Ordered function calls SHALL retain identifiers and untrusted arguments for
dispatcher validation. Completed final answers SHALL include final output text
and exclude reasoning and refusals. Network, HTTP, malformed response, and
incomplete-stream failures SHALL be sanitized rather than exposing provider
bodies, authorization headers, or credentials.

#### Scenario: Malformed tool arguments

- **WHEN** a provider function call contains malformed arguments
- **THEN** normalization retains an untrusted value for dispatcher rejection rather than executing it

#### Scenario: Failed provider request

- **WHEN** the provider rejects a request or its stream ends without valid completion
- **THEN** the adapter reports a sanitized failure that the loop handles as a transport error

### Requirement: Confirmed indexed answer release

The optional per-request `onFinalAnswerDelta` callback SHALL release only
provider-confirmed final-answer text. The adapter SHALL buffer deltas and
correlate their `output_index` with completed output-item identity before
release, preserving output order. Reasoning, refusal, commentary, and
unclassified items SHALL NOT enter the answer channel. Missing or ambiguous
identity, malformed ordering, or unreconciled content SHALL suppress delayed
delta release and use the authoritative completed answer. Transports without
safe delivery MAY ignore the callback. This is delayed confirmed delivery,
not a guarantee of byte-by-byte streaming.

#### Scenario: Interleaved confirmed items

- **WHEN** answer deltas arrive interleaved for multiple confirmed output items
- **THEN** released text follows output-index order and excludes non-answer items

#### Scenario: Ambiguous identity

- **WHEN** a delta cannot be correlated with completed final-answer identity
- **THEN** it is not released and the completed-answer fallback remains available

### Requirement: Cancellable trusted request lifecycle

Trusted model requests SHALL honor an optional run-cancellation signal through
credential resolution, authenticated fetch, and response consumption. A
pre-aborted request SHALL send no fetch. Cancellation SHALL await owned reads,
body cleanup, and credential-store lock release. A valid rotated credential
already obtained SHALL finish required persistence before settlement.

#### Scenario: Cancellation during credential work

- **WHEN** the run is cancelled while credential resolution or refresh is pending
- **THEN** no model fetch starts afterwards and cancellation waits for safe credential cleanup
- **AND** any valid rotated credential already obtained is persisted through the serialized store before settlement

#### Scenario: Cancellation during request fetch

- **WHEN** the run is cancelled during authenticated fetch
- **THEN** the request receives abort and settles with safe cancellation classification without exposing headers, credential data, or provider bodies

#### Scenario: Cancellation during SSE read

- **WHEN** the run is cancelled while a response body read is pending
- **THEN** response consumption stops, reader cleanup is awaited, and no later model work starts

#### Scenario: Cancellation while handling an HTTP error

- **WHEN** an HTTP error response races with cancellation
- **THEN** its body is released before transport settlement and the runtime applies its terminal arbitration without exposing the provider body

### Requirement: Cancellation gates answer delivery

Once trusted cancellation is observed, response callbacks and late transport
settlement SHALL NOT publish new answer text or create a completed answer.
Previously emitted confirmed text SHALL remain displayed as partial evidence;
it SHALL NOT be treated as a final answer. Without cancellation, existing
confirmed indexed delivery and completed-answer fallback SHALL be preserved.

#### Scenario: Late confirmed answer callback

- **WHEN** a transport invokes an answer callback after cancellation or terminal commit
- **THEN** the callback cannot append text, mutate the settled result, or affect the next run

#### Scenario: Partial answer before cancellation

- **WHEN** confirmed text was displayed before cancellation but completion was not committed
- **THEN** the text is not erased, the run settles cancelled, and no completed-answer fallback is fabricated
