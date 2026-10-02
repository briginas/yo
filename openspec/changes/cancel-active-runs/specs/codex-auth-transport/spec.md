# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
