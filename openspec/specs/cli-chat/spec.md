# CLI chat Specification

## Purpose

Define the single interactive entrypoint and ephemeral conversation ownership.
This baseline imports implemented Milestone 2 behavior with subsequent CLI
retirement and patch integration already applied. It uses the
[agent harness](../agent-harness/spec.md),
[Codex transport](../codex-auth-transport/spec.md), and
[run observation](../run-observation/spec.md) contracts.

## Requirements

### Requirement: Single agent entrypoint

The CLI SHALL expose `yo [--cwd <workspace>] [--model <name>]` as its only agent
workflow. Omitted `--cwd` SHALL select the current directory; an explicit model
SHALL be passed to the transport. `yo login`, `yo auth status`, and `yo logout`
SHALL remain separate trusted commands. Removed `ask` and `chat` subcommands,
positional task arguments, unknown options, repeated options, missing or blank
option values, and unexpected authentication-command arguments SHALL be rejected
with usage and exit code 2.

#### Scenario: Current workflow

- **WHEN** `yo --cwd <directory> --model <name>` starts
- **THEN** it canonicalizes that directory and starts chat with the selected model

#### Scenario: Retired commands

- **WHEN** a user invokes `yo ask` or `yo chat`
- **THEN** the CLI rejects the positional argument instead of starting a second workflow

### Requirement: Ephemeral structured conversation

The conversation SHALL retain one system prompt plus user messages, assistant
messages, tool calls, and structured tool results for later turns in the same
process. Each turn SHALL append only its new transcript suffix, without
duplicating prior messages. Workspace root and model SHALL remain fixed for the
session. Chat SHALL NOT persist a transcript or pending approval, or provide
branching, compaction, cross-session resume, skills, MCP, or subagents.

#### Scenario: Context-dependent follow-up

- **WHEN** a user asks a second question after a tool-using first turn
- **THEN** the next request contains the earlier messages and observations exactly once

#### Scenario: Fresh process

- **WHEN** the user exits and starts `yo` again
- **THEN** the earlier transcript and pending state are unavailable; chat creates no persistent state file

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

### Requirement: Answer and terminal lifecycle separation

Provider-confirmed final-answer text SHALL reach rendering through runtime
events, with completed-answer fallback for transports without safe deltas.
Automatic output SHALL show the answer once, terminate its line before durable
status, and avoid repeating it in the result summary. TTY progress SHALL be
cleaned up on completion and failure; non-TTY status SHALL be stable line-oriented
output without renderer-generated terminal control sequences. Status SHALL use
bounded known-argument summaries rather than raw tool results or unknown objects,
and SHALL NOT expose hidden reasoning, OAuth credentials, headers, raw provider
payloads, or unsanitized provider errors. Explicit retained-answer inspection is
governed separately by run observation.

#### Scenario: Transport without safe deltas

- **WHEN** a transport returns a complete final answer without releasing deltas
- **THEN** the CLI prints the completed answer once before the final status

#### Scenario: Live answer followed by summary

- **WHEN** confirmed answer text has already been rendered
- **THEN** the automatic result summary does not print the answer again

### Requirement: Workspace mutation remains separately approved

Chat itself SHALL NOT write workspace files or run processes. Its sole
model-proposed workspace mutation SHALL be the exact approval-gated patch
workflow. Approval responses SHALL remain outside the transcript and SHALL
authorize only the currently displayed proposal. Closing chat SHALL discard
memory without undoing patches already successfully applied.

#### Scenario: Read-only conversation

- **WHEN** a conversation inspects files and exits without an approved patch
- **THEN** the approved workspace remains unchanged

### Requirement: Active-turn interrupt routing

Ctrl+C during an active chat turn SHALL request trusted run cancellation.
Repeated interrupts during settlement SHALL remain idempotent. The CLI SHALL
wait for settlement before another task, inspection, or approval read. At an
idle prompt Ctrl+C SHALL exit cleanly without allocating a run. Interrupt
handlers SHALL be scoped to chat and released on exit.

#### Scenario: Active model work

- **WHEN** Ctrl+C arrives during a pending model request in interactive chat
- **THEN** the CLI requests cancellation without another line read and returns to the prompt only after settlement

#### Scenario: Non-TTY interrupt

- **WHEN** chat receives process SIGINT with non-interactive input
- **THEN** the same trusted cancellation flow settles active work and produces durable textual status without granting patch consent

#### Scenario: Repeated interrupt during cleanup

- **WHEN** Ctrl+C arrives again while the cancelled run is still cleaning up
- **THEN** it neither force-exits nor detaches the work nor allocates another run

#### Scenario: Idle interrupt

- **WHEN** Ctrl+C arrives at an idle chat prompt
- **THEN** input and interrupt handlers close cleanly with no model request, transcript entry, or run allocation

#### Scenario: Post-cancellation task

- **WHEN** a cancelled turn settles and the user inspects it, then submits another task
- **THEN** inspection uses retained evidence and the new turn receives fresh budgets and the cancelled turn's structured suffix exactly once
- **AND** neither interrupt control nor approval input is added as a user message

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
