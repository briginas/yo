# Agent harness Specification

## Purpose

Define the implemented provider-neutral model/tool loop and bounded workspace
inspection. Imported from the implemented Milestone 1 baseline on 2026-10-02,
with the current four-tool registry and chat-only entrypoint. CLI ownership is
specified in [CLI chat](../cli-chat/spec.md), authentication and conversion in
[Codex authentication and transport](../codex-auth-transport/spec.md), writes in
[approval-gated patching](../approval-gated-patching/spec.md), and presentation in
[run observation](../run-observation/spec.md).

## Requirements

### Requirement: Closed model capability boundary

The harness SHALL expose only `list_files`, `search_code`, `read_file`, and
`propose_patch` to the model. Model arguments SHALL remain untrusted until the
selected strict schema validates them. Unknown properties SHALL be rejected.
The model SHALL NOT receive direct filesystem access, arbitrary write, process,
shell, network, credential, environment-reading, or connector tools. Trusted
OAuth and provider requests SHALL remain outside this tool registry.

#### Scenario: Unsupported capability request

- **WHEN** the model requests an unknown tool, including a shell or general write tool
- **THEN** the dispatcher returns `unknown_tool` without executing that capability

#### Scenario: Invalid known-tool arguments

- **WHEN** a known tool receives malformed arguments or unknown properties
- **THEN** it returns `invalid_arguments` before filesystem execution

### Requirement: Canonical workspace and sensitive-path enforcement

The harness SHALL canonicalize one existing directory as the workspace root.
Read-tool authorization SHALL check both lexical and canonical path containment
and sensitive-path policy, and filesystem tools SHALL repeat authorization
internally. Traversal, absolute escapes, symlink escapes, and aliases to
sensitive targets SHALL be denied. Path-segment checks SHALL be case-insensitive
for `.env*`, `.git`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.pypirc`, `.netrc`,
`credentials.json`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, and extensions
`.key`, `.pem`, `.p12`, `.pfx`. Patch targets have the stricter no-symlink rules
in the patching specification.

#### Scenario: Outside or sensitive target

- **WHEN** a read path escapes the workspace or resolves to a sensitive path
- **THEN** the result is denied and target content is not returned

#### Scenario: Invalid workspace

- **WHEN** the selected workspace cannot resolve to an existing directory
- **THEN** setup fails before the chat input loop or a model request begins

### Requirement: Bounded sequential agent loop

The harness SHALL build requests from the system prompt, retained structured
messages, current user task, and visible tool definitions. It SHALL execute
each response's tool calls sequentially in provider order, append their results,
and request the next model step within the fixed model-request budget. A final
answer SHALL end the run with `completed` / `final_answer`; transport failure
SHALL end it with `failed` / `transport_error`; exhaustion SHALL end it with
`aborted` / `step_budget_exhausted`. A trusted run-cancellation signal SHALL end a nonterminal run with `aborted` /
`aborted` after active work and cleanup settle. No automatic transport retry is
provided.

#### Scenario: Search then read

- **WHEN** a faux model requests `search_code`, then `read_file`, then returns an answer
- **THEN** each next request contains the preceding structured observations and the run retains the final answer

#### Scenario: Exhaustion after tool work

- **WHEN** the final allowed model request returns tool calls
- **THEN** their ordered results are retained before budget exhaustion is reported, without another model request

### Requirement: One terminal result per requested call

Every requested tool call SHALL produce exactly one `ToolResult` with its call
identifier and one `tool_completed` event. Status SHALL distinguish `success`,
`invalid_arguments`, `unknown_tool`, `denied`, `timeout`, `execution_error`, and
`aborted`. Failures SHALL carry a machine-readable error code and message;
results SHALL carry truncation metadata. A read executor exceeding its configured
timeout SHALL be stopped cooperatively and awaited through I/O and cleanup
before yielding its sole timeout result. Late settlement SHALL NOT append a
second result. Unstarted calls accepted before run cancellation SHALL receive
one aborted result without execution. Mutation timeout behavior is specified separately for patches.

#### Scenario: Multiple calls with mixed outcomes

- **WHEN** one response contains successful, denied, and invalid calls
- **THEN** each call receives one ordered result, and a failure does not drop the remaining calls

#### Scenario: Late read completion

- **WHEN** a timed-out read executor and its cleanup settle, then a stale callback arrives
- **THEN** its recorded timeout remains the sole result for that call and no later run is changed

### Requirement: Bounded file listing

`list_files({ path, glob?, limit? })` SHALL list sorted workspace-relative paths.
Without a glob it SHALL list immediate entries; glob matching SHALL be relative
to the requested directory and may recurse. Sensitive paths, `node_modules`,
and symlink entries SHALL be omitted. The default and maximum result limit SHALL
be 500; an explicit limit SHALL be a positive integer.

#### Scenario: Sorted bounded listing

- **WHEN** a directory contains more eligible entries than the requested limit
- **THEN** listing applies that limit after sorting and reports result truncation

### Requirement: Literal code search

`search_code({ query, path?, glob?, limit? })` SHALL perform non-empty,
case-sensitive literal search, defaulting the path to the workspace root.
It SHALL support direct-file search and recursive directory search with optional
glob filtering, return workspace-relative paths and line numbers in stable path
order, and skip sensitive paths, `node_modules`, symlink entries, and non-text
files. Its default and maximum match limit SHALL be 100.

#### Scenario: Literal matching and evidence

- **WHEN** a query containing regular-expression metacharacters matches file text
- **THEN** search treats those characters literally and returns matching paths and line numbers

### Requirement: Line-oriented text reading

`read_file({ path, startLine?, endLine? })` SHALL read UTF-8 text with normalized
line endings and original one-based line numbers. Optional bounds SHALL be
positive integers forming an inclusive range with start no greater than end.
Directories, invalid UTF-8, NUL-containing binary content, and a start beyond
the file SHALL fail. An empty file SHALL return empty content.

#### Scenario: Selected line range

- **WHEN** lines 2 through 3 are requested from a four-line text file
- **THEN** only those lines are returned with their original numbers

### Requirement: Explicit output bounds

Read-tool output SHALL be capped at 50 KiB of UTF-8 output including separators;
`read_file` SHALL additionally be capped at 2,000 lines. Listing and search SHALL
apply their result limits. Truncation SHALL retain complete items and report
`reason`, `limit`, and `observed`; complete output SHALL report `truncated: false`
and `truncation: null`. Exactly reaching a limit without omitted output SHALL
NOT be marked truncated.

#### Scenario: Exact limit and first omitted item

- **WHEN** output fits exactly at the byte, line, or result limit
- **THEN** it is complete, and only a further item that cannot be retained causes truncation metadata

### Requirement: Ordered non-owning lifecycle observation

The loop SHALL record run, model, tool, final-answer, and finish events in
execution order before notifying observers. Observers SHALL receive detached,
deeply frozen snapshots; observer exceptions SHALL NOT change execution,
transcript, results, or permissions. Safe terminal projection, evidence summaries,
and retained run inspection SHALL follow the run-observation specification.

#### Scenario: Faulty observer

- **WHEN** an observer throws or attempts to mutate a nested event snapshot
- **THEN** the run and its original messages and results remain unaffected

### Requirement: Trusted cancellation request and settlement

Cancellation SHALL be trusted control outside the model tool registry. A first
request for a nonterminal run SHALL emit one ordered cancellation-request event
and stop new operations. Duplicate requests SHALL have no additional effect.
The run SHALL remain unsettled until active work and cleanup finish. A
pre-aborted run SHALL retain its task and finish without a model request.

#### Scenario: Cancellation before execution

- **WHEN** a turn starts with an already-aborted trusted signal
- **THEN** it records start and cancellation evidence, retains the task, and settles with `aborted` / `aborted` without model or tool execution

#### Scenario: Uncooperative active work

- **WHEN** cancellation is requested while an owned operation has not yet settled
- **THEN** no new operation starts and the run does not report settlement until that operation and cleanup finish

#### Scenario: Repeated and stale requests

- **WHEN** the same active run receives repeated requests or an old controller is used after its run settles
- **THEN** the active run records at most one request event and no later run is affected

### Requirement: Cancellation preserves accepted call accounting

Cancellation SHALL preserve accepted messages and completed tool results. Calls
in a response accepted before cancellation SHALL each receive one ordered
terminal result. Unstarted calls SHALL receive `aborted` without authorization
or execution. After cancellation the loop SHALL make no further model request.
A response arriving after the cancellation gate SHALL NOT create new calls.

#### Scenario: Cancellation in a multi-call response

- **WHEN** cancellation occurs during the second of three accepted calls
- **THEN** the first result is preserved, the second settles, and the third has one aborted result and requested/completed evidence without execution
- **AND** all call IDs and provider order are preserved, with no next model request

#### Scenario: Late model response

- **WHEN** a model response arrives after cancellation was observed
- **THEN** it creates no tool execution, assistant answer, or accepted call batch

### Requirement: Terminal outcome arbitration

The runtime SHALL commit one terminal status and reason. A committed outcome
SHALL survive later cancellation. Cancellation observed before acceptance of a
final response SHALL prevent completion and answer publication. Cancellation
SHALL NOT replace an already committed tool result or reverse a successful
patch. An approver-only abort SHALL NOT imply run cancellation.

#### Scenario: Completion wins

- **WHEN** runtime commits completion before a cancellation request, while outer settlement or rendering is still pending
- **THEN** the final result remains completed and retains its answer

#### Scenario: Cancellation wins

- **WHEN** cancellation is observed before a pending final response is accepted
- **THEN** the response is discarded and the settled result is aborted with reason aborted

#### Scenario: Approval-only abort

- **WHEN** an approver returns aborted while the trusted run signal is not aborted
- **THEN** only that patch call is aborted and normal run continuation remains possible

### Requirement: First stop cause with settled tool cleanup

For an active tool, the first observed timeout or run-cancellation stop cause
SHALL determine its stopped result. Its outstanding I/O and cleanup SHALL be
awaited before that result returns. A prior committed operation outcome SHALL
be preserved. Successful atomic patch replacement SHALL retain success even
if a stop request arrived while rename was settling.

#### Scenario: Timeout precedes cancellation

- **WHEN** a tool timer requests stop before run cancellation and cleanup remains pending
- **THEN** the sole tool result is timeout after cleanup, while the run subsequently settles cancelled

#### Scenario: Cancellation precedes timeout

- **WHEN** run cancellation requests stop before the tool timer
- **THEN** the sole stopped tool result is aborted after cleanup, without later replacement by timeout

#### Scenario: Timed-out read remains pending

- **WHEN** a read timer fires but its underlying read promise is still pending
- **THEN** no timeout result, subsequent call, or settled run is returned until that read and cleanup finish
