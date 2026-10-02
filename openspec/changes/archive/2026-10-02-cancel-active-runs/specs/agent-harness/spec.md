# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
