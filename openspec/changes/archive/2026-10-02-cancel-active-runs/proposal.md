# Proposal

## Why

The session can display and inspect runs, but the user cannot stop an active
model request, read operation, or patch approval and safely continue chatting.
Cancellation is the next increment before explicit rerun and allowlisted
validation in the [project map](../../../../IMPLEMENTATION_PLAN.md).

## What Changes

- Introduce one trusted controller per active turn, with a cancellation request
  and a separate wait for settlement, following pi's session abort-and-wait flow.
- Use Ctrl+C during an active chat turn to request cancellation, without starting
  another line read. At an idle prompt it exits cleanly; repeated active requests
  remain idempotent and never force detached work or process termination.
- Propagate an optional run signal through conversation, model transport,
  dispatcher, filesystem work, and exact patch preparation/approval/application.
- Show `cancellation requested` while work settles and `cancelled` only for a
  runtime-confirmed `aborted` / `aborted` result. Preserve a terminal outcome
  already committed by runtime, including completion winning a race.
- Retain exactly one result for every accepted tool call, including calls skipped
  after cancellation. Retain partial conversation evidence for the next task.
- Settle timed-out read/preparation I/O before returning its sole timeout result;
  the execution timer is not a promise of an immediate settled return.
- Preserve patches whose atomic replacement succeeds; cancellation supplies no
  consent, undo, retry, or new model-visible capability.

## Capabilities

### New Capabilities

None. Cancellation belongs to the existing execution and presentation boundaries.

### Modified Capabilities

- `agent-harness`: trusted abort propagation, terminal arbitration, complete call
  accounting, and settled tool timeout behavior.
- `cli-chat`: active-turn interruption, sequential input recovery, and retention
  of a cancelled turn's structured evidence.
- `codex-auth-transport`: signal-aware credential resolution, authenticated fetch,
  stream cleanup, and suppression of late answer delivery.
- `approval-gated-patching`: cancellation of preparation/review/application with
  unchanged exact consent and successful-rename semantics.
- `run-observation`: requested cancellation activity and runtime-confirmed
  cancelled presentation with frozen settled evidence.

## Impact

Affected implementation areas are `src/cli-app.ts`, `src/cli.ts`,
`src/line-input.ts`, `src/terminal-approval.ts`, runtime turn/loop/dispatch and
filesystem/patch modules, the Codex transport and request credential resolver,
and observation/terminal projections. Optional signal/control arguments extend
trusted TypeScript APIs; the four-tool model registry and argument schemas remain
unchanged. No dependency, API key, runtime configuration, persistent state,
process tool, or general network capability is added.

### Acceptance criteria

Cancellation before execution, during credential/model/tool/approval work, and
between sequential calls stops new work and waits for owned resources to settle.
Repeated requests produce one cancellation event and one terminal run outcome.
Both terminal race orders, timer/cancellation race orders, and rename success
after an interrupt are tested. Input recovery cannot leak approval text into a
later task or let stale consent apply a patch. After cancellation the user can
inspect the retained run and submit a fresh turn with fresh budgets and consent.
Observers remain non-owning and secrets stay outside display and model context.

### Authorization and deferred scope

This change is a planning proposal authorized on 2026-10-02. No implementation
leaf or requirement synchronization is approved by artifact completeness. The
first candidate was task group 1: trusted controller and signal contracts. The
user confirmed that bounded implementation on 2026-10-02; its checks and pending
human result acceptance are recorded in [verification](verification.md).
The user then explicitly authorized the next bounded group 2 in a separate
subagent on the same date. Its settled read/preparation behavior, checks, and
pending human result acceptance are recorded in verification. The user then
requested committing group 2 and implementing the next bounded group 3 in a
separate subagent. Group 2 was committed as `b061aee`; group 3 checks and pending
human result acceptance are recorded in verification. The user then requested
committing group 3 and implementing the next bounded group 4 in a separate
subagent. Group 3 was committed as `c77cdf9`; group 4 checks and pending human
result acceptance are recorded in verification. The user subsequently requested implementation of the remaining change with a
commit after each step. This authorizes groups 5–8 implementation in sequence;
task 8.3 required explicit result acceptance before synchronization/archive.
After final integration verification in `755d9c9`, the user accepted the result
and authorized closure with “it's ok. go” on 2026-10-02. The verified deltas are
now synchronized into main specs and this change is archived. See verification
for closure checks and the unchanged coverage limits.

Explicit rerun, validation, automatic retry/repair, rollback, force termination,
multiple active turns, `/cancel` line commands, TUI, durable history, and login
command cancellation are deferred. Cancellation cannot guarantee an elapsed-time
bound when an underlying operation does not cooperate; it must keep showing the
requested state until settlement instead of claiming work has stopped.
