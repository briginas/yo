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

### Requirement: Fresh budgets and recoverable turn failure

Each CLI task SHALL start with a fresh budget of 10 model requests and a
5,000 ms per-tool execution timeout. Patch review time SHALL be excluded as
specified in approval-gated patching. Transport failure and budget exhaustion
SHALL end only the current turn, retain its structured messages, report its
sanitized outcome, and return to input. Workspace setup and input failures SHALL
terminate the chat with cleanup. User cancellation SHALL settle only the current turn, retain its structured
evidence, and return to input after cleanup. Explicit rerun remains outside the
current contract.

#### Scenario: Failed turn followed by another task

- **WHEN** transport failure or budget exhaustion ends a task
- **THEN** a later task can run with a reset budget in the same conversation

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
