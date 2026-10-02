# Spec Delta

## MODIFIED Requirements

### Requirement: Lifecycle is separate from activity

An observed run SHALL remain running while starting, waiting for the model,
executing tools, waiting for patch approval, or finishing. A settled session
SHALL determine the final outcome and stop reason. The display SHALL distinguish
completed, failed, aborted, and budget-exhausted outcomes with cancelled presentation only for runtime-confirmed `aborted` / `aborted`,
without inventing cancellation from request activity or transport diagnostics.

#### Scenario: Finishing event precedes settled session

- **WHEN** the runtime emits `run_finished`
- **THEN** the event is retained as feed evidence and the record remains running until session settlement

#### Scenario: Tool failure is followed by a successful answer

- **WHEN** a tool returns an error and the settled session completes with an answer
- **THEN** the result is completed and still contains the tool error evidence

#### Scenario: Budget, transport, and invocation failures differ

- **WHEN** the session reports `step_budget_exhausted` or `transport_error`, or the CLI turn invocation unexpectedly throws
- **THEN** observation respectively reports budget exhaustion, the safe transport-error reason, or display-only `cli_turn_error`
- **AND** it preserves available partial evidence without fabricating cancellation or raw error diagnostics

### Requirement: Patch display does not grant consent

Observation SHALL distinguish preparation, waiting, approval, denial, abort,
conflict, and confirmed application using runtime evidence. Patch trails SHALL
preserve each call's progression. The trusted terminal approver SHALL retain
exclusive ownership of approval input and the complete exact diff. Only its
existing explicit consent may authorize application; display state SHALL NOT
approve a patch or infer whole-run cancellation from a patch approval abort without trusted
run cancellation evidence.

#### Scenario: Waiting for an exact patch decision

- **WHEN** a patch requests approval
- **THEN** the run remains running with approval activity and the existing complete diff and explicit approval prompt are shown
- **AND** input belongs to that approval request rather than a new model task

#### Scenario: Decision and application differ

- **WHEN** approval is denied, aborted, followed by a conflict, or followed by confirmed application
- **THEN** observation records that actual trail without claiming application merely from approval

## ADDED Requirements

### Requirement: Requested cancellation remains running

A runtime cancellation-request event SHALL create one ordered safe feed row
and show cancellation-requested activity while the run is unsettled. Later
operation and finishing events SHALL preserve that activity. The final result
SHALL derive from runtime settlement, not the request, observer, or display.
Duplicate requests SHALL NOT add repeated cancellation rows.

#### Scenario: Request while I/O settles

- **WHEN** cancellation is requested while a tool or transport cleanup is pending
- **THEN** the record remains running and displays cancellation requested until settlement, with no cancelled result card yet

#### Scenario: Operation events after request

- **WHEN** tool completion, patch application, or run-finished events arrive after the request and before settlement
- **THEN** their evidence is retained while cancellation-requested activity remains visible

#### Scenario: Completed outcome wins race

- **WHEN** a cancellation request races with an already committed runtime completion
- **THEN** settlement displays completed and does not relabel it cancelled

### Requirement: Settled cancellation is inspectable

A settled session with status aborted and reason aborted SHALL display
cancelled in its result and retained inspection. Budget exhaustion SHALL remain
distinct. Tool and patch trails, errors, timing, and absent-final-answer labels
SHALL retain their safe evidence. Late callbacks SHALL NOT reopen or modify a
settled record. Cancellation display SHALL add no execution or consent authority.

#### Scenario: Inspect cancelled run and continue

- **WHEN** a cancelled run is inspected with `/runs` and `/run N`, then another task runs
- **THEN** the selected run retains its cancelled result, original ordered evidence, and frozen timing while the next run has a separate identity

#### Scenario: Applied patch in cancelled run

- **WHEN** an atomic patch replacement succeeded before the cancelled run settled
- **THEN** retained inspection shows both cancellation and applied patch evidence without implying rollback

#### Scenario: Observation failure during cancellation

- **WHEN** rendering, projection, clock, or diagnostic output fails while cancellation is requested
- **THEN** runtime cancellation, safe cleanup, exact patch consent, and conversation settlement proceed independently
