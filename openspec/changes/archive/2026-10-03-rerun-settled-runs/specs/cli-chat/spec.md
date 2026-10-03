# CLI chat delta: explicit rerun

## MODIFIED Requirements

### Requirement: Sequential input ownership

Chat SHALL own one line-input reader, await the active turn before accepting
another task, and reuse that reader sequentially for patch approval. Whitespace-only
input SHALL be ignored locally. EOF and the exact line `/exit` SHALL terminate
cleanly without a model request or transcript entry. Accepted ordinary input
SHALL retain its original whitespace. Between-turn `/runs` and `/run N` commands
SHALL follow the local-command rules in the run-observation specification.
Between-turn `/rerun N` SHALL follow the explicit rerun rules below and SHALL
never create concurrent execution or an additional input owner.

Trusted interrupt notification SHALL be separate from line reads. Cancelling a
pending approval read SHALL release that read's ownership without closing the
shared reader. Partial or buffered input received during cancellation and late
resolution of that cancelled read SHALL NOT enter a future approval or task.
Fresh lines received after the next prompt SHALL retain ordinary input handling.

#### Scenario: Exit token must be exact

- **WHEN** a line contains `/exit` with surrounding spaces
- **THEN** it is ordinary task text; only exact `/exit` exits

#### Scenario: Active patch approval

- **WHEN** a patch is waiting for approval
- **THEN** that input is consumed by the approver, never appended as a chat message or interpreted as between-turn navigation

#### Scenario: Cancel approval and continue

- **WHEN** an interrupt cancels the active approval read and that cancelled read resolves late with an affirmative response
- **THEN** it cannot apply the cancelled proposal or become a later chat task
- **AND** after settlement a fresh input line can start the next turn

#### Scenario: Command-like approval input

- **WHEN** `/rerun 1` is entered at a patch approval prompt
- **THEN** it is a nonaffirmative approval response that denies the displayed patch
- **AND** it creates no rerun action, transcript entry, or queued replay

### Requirement: Fresh budgets and recoverable turn failure

Each CLI task SHALL start with a fresh budget of 10 model requests and a
5,000 ms per-tool execution timeout. Patch review time SHALL be excluded as
specified in approval-gated patching. Transport failure and budget exhaustion
SHALL end only the current turn, retain its structured messages, report its
sanitized outcome, and return to input. Workspace setup and input failures SHALL
terminate the chat with cleanup. User cancellation SHALL settle only the current turn, retain its structured
evidence, and return to input after cleanup. An explicitly accepted rerun SHALL
start a new bounded turn under these same rules; no automatic rerun or transport
retry SHALL occur.

#### Scenario: Failed turn followed by another task

- **WHEN** transport failure or budget exhaustion ends a task
- **THEN** a later task can run with a reset budget in the same conversation

#### Scenario: Rerun after budget exhaustion

- **WHEN** the user explicitly reruns a settled budget-exhausted turn
- **THEN** the new attempt starts with all ten model requests and its own tool timeout budget
- **AND** the earlier attempt's step count and stop reason remain unchanged

#### Scenario: Failure without explicit request

- **WHEN** a turn fails, is cancelled, or exhausts its budget and no rerun command is submitted
- **THEN** no new attempt or model request is scheduled

## ADDED Requirements

### Requirement: Precisely recognized rerun command

At the between-turn prompt the CLI SHALL reserve lowercase `/rerun` and accept
exactly one positive safe-integer decimal number matching `[1-9][0-9]*`.
Surrounding whitespace and space/tab separators SHALL be accepted. Malformed
reserved input SHALL produce local usage without execution. Other tokens SHALL
retain ordinary handling and whitespace.

#### Scenario: Valid command variants

- **WHEN** the user submits `/rerun 2`, surrounding-whitespace variants, or `/rerun` followed by a tab and `2`
- **THEN** the CLI selects source run 2 under the rerun source and action rules
- **AND** the command string itself is never a model user message

#### Scenario: Malformed reserved input

- **WHEN** the user enters `/rerun`, `/rerun 0`, `/rerun -1`, `/rerun 01`, `/rerun 1.5`, `/rerun 1e2`, `/rerun 9007199254740992`, or `/rerun 1 extra`
- **THEN** local usage is displayed and no model request, transcript entry, run number, or tool execution is created

#### Scenario: Other tokens remain ordinary

- **WHEN** the user enters `/rerunner`, `/RERUN 1`, or ordinary text with surrounding spaces
- **THEN** the original line follows existing ordinary task handling without normalization
- **AND** blank input, EOF, and exact `/exit` retain existing behavior

### Requirement: Settled current-session rerun source

Rerun SHALL select only a settled attempt in the current chat session. Completed,
transport-failed, cancelled, and budget-exhausted sources SHALL be eligible.
Unknown or unsettled sources SHALL yield a safe local diagnostic without new
execution, transcript mutation, or run allocation. Rerun SHALL use the complete
source task including original whitespace, independently of its display preview.

#### Scenario: Every returned terminal outcome is eligible

- **WHEN** the user selects a completed, transport-failed, cancelled, or budget-exhausted attempt after it settles
- **THEN** each source can create a new explicitly requested attempt
- **AND** the source status, reason, messages, and results remain unchanged

#### Scenario: Invalid source is local

- **WHEN** a selection refers to a missing source, an unsettled source, or a run from an earlier chat process
- **THEN** the CLI reports source unavailability without allocating or executing an attempt
- **AND** the next ordinary task keeps the next unused run number

#### Scenario: Full task survives lossy preview

- **WHEN** a source task is longer than the display preview, contains Unicode and original whitespace, or has a redacted preview
- **THEN** the rerun task exactly equals the accepted source task rather than its truncated or sanitized preview
- **AND** full task text is not added to observation records or diagnostic output

### Requirement: Rerun uses current conversation and workspace

An accepted rerun SHALL create a new increasing session-local run number linked
to the directly selected source and execute its task against the current
conversation and workspace. Prior structured messages SHALL appear once; one
new exact task and only the new attempt's suffix SHALL be appended. No original
context or filesystem snapshot SHALL be restored, and no source call SHALL be
replayed by the command.

#### Scenario: Intervening turns are retained

- **WHEN** run 1 settles, run 2 adds a correction, and the user submits `/rerun 1`
- **THEN** run 3 receives the current conversation including both earlier turns exactly once followed by run 1's exact task
- **AND** neither `/rerun 1` nor input action metadata enters the model transcript

#### Scenario: Files change before a rerun

- **WHEN** a source read a file, that file changes, and a rerun requests another read of it
- **THEN** the new tool result reflects current file bytes rather than a cached source result
- **AND** earlier observations remain historical context without restoring old bytes

#### Scenario: Rerun of a rerun

- **WHEN** run 2 is a settled rerun of run 1 and the user submits `/rerun 2` at a fresh prompt
- **THEN** a new run repeats run 2's exact task with source link 2 and current context
- **AND** runs 1 and 2 retain their existing linkage and outcomes

### Requirement: One attempt per rerun action

A rerun action SHALL be identified by its selected source and trusted input
arrival window. Repeated delivery within that window SHALL refer to one accepted
attempt without allocating or executing another. A new between-turn prompt SHALL
permit a deliberate later action. Buffered lines SHALL retain their arrival
identity across settlement. Ordinary tasks SHALL NOT be deduplicated.

#### Scenario: Duplicate delivery during active work

- **WHEN** one accepted rerun action is delivered again before its attempt settles
- **THEN** it refers to the same new run number with no additional controller, budget, observation record, model request, or transcript suffix

#### Scenario: Buffered duplicate after settlement

- **WHEN** two equivalent `/rerun 1` lines arrive before a fresh post-settlement prompt and the second is dequeued after the first attempt settles
- **THEN** only one new attempt exists and the second line produces a safe existing-attempt diagnostic
- **AND** the duplicate is not reclassified as a fresh action by the later read

#### Scenario: Deliberate later attempt

- **WHEN** the user enters `/rerun 1` after settlement at a newly opened between-turn prompt
- **THEN** a new action can allocate another linked attempt despite the same source number and task text

#### Scenario: Mixed buffered input and EOF

- **WHEN** ordinary tasks, inspection, duplicate rerun lines, and exit or EOF occur in a buffered input sequence
- **THEN** duplicate reruns allocate no extra runs while ordinary tasks and inspection retain existing ordered handling
- **AND** buffered duplicate suppression does not depend on a timer or new input arriving before EOF

#### Scenario: Reader cannot establish arrival identity

- **WHEN** a chat input adapter cannot distinguish line arrival windows and receives `/rerun N`
- **THEN** rerun is rejected locally with a safe input-capability diagnostic rather than assigning identity at dequeue
- **AND** ordinary tasks and inspection remain available

### Requirement: Rerun preserves cancellation and patch boundaries

Every new attempt SHALL use a fresh trusted cancellation controller and the
existing settled execution path. Rerun SHALL NOT reuse proposals, approvals, or
signals, undo applied patches, or grant new permissions. Any new patch SHALL
require preparation against current bytes, a complete preview, and fresh consent.
Cancellation SHALL settle the new attempt before another chat read.

#### Scenario: Prior approval does not authorize a rerun patch

- **WHEN** a source applied a patch and its rerun proposes another patch
- **THEN** the prior patch stays applied and the new proposal waits for its own complete-diff consent
- **AND** denial of the new proposal leaves current bytes unchanged

#### Scenario: Cancelled review followed by rerun

- **WHEN** source review was cancelled and a later rerun proposes a patch
- **THEN** it prepares and reviews a new proposal and cannot use late affirmative input from the cancelled review

#### Scenario: Cancellation during new work

- **WHEN** the new rerun attempt is interrupted while cleanup remains pending
- **THEN** it remains active until existing runtime and cleanup settlement finishes, with no concurrent task or automatic retry
- **AND** the earlier source remains unchanged and a later fresh attempt gets a non-aborted controller

#### Scenario: Noninteractive rerun

- **WHEN** `/rerun N` is submitted through a noninteractive reader with arrival identities
- **THEN** the new attempt may execute normally but any patch remains subject to existing noninteractive denial
