# Design

## Context

See [proposal](proposal.md) for motivation and authorization. This design records
the implementation accepted on 2026-10-02. The current
[specifications](../../../specs/) include its verified deltas; staged checks and
closure evidence are retained in [verification](verification.md).

### Execution before this change

`cli-app.ts` allocates an observation record before awaiting
`runConversationTurn`. The conversation invokes `runAgent`, then appends only
the turn's new messages. `agent-loop.ts` awaits one model response and dispatches
its calls sequentially. Neither entrypoint accepts a run signal.

`ModelTransportOptions` has only an answer callback. The Codex transport resolves
credentials, fetches, and reads SSE with eventual reader cleanup; none accepts
run cancellation. `tool-dispatcher.ts` races read and patch-preparation promises
against a timeout, allowing underlying read I/O to finish later. In contrast,
`patch-applier.ts` already checks an internal timeout signal between awaits and
before rename, waits for cleanup, and preserves successful rename.

`line-input.ts` owns a persistent readline interface using an async iterator.
`terminal-approval.ts` borrows the same input for one approval. It cannot cancel
a pending read without closing the reader. Observation finalizes only after
the turn returns, independently of `run_finished`; it has no control authority.

### Target execution and component roles

A trusted turn controller exists before invocation. Ctrl+C requests cancellation
on that controller; it does not provide chat text or patch consent. The controller
aborts its signal once and exposes a promise for the turn's settled result. The
loop records a cancellation-request event once, blocks further work, and passes
the signal into the active operation. That operation stops at a safe boundary,
awaits outstanding I/O, and releases timers, readers, handles, and listeners.
The loop accounts for all accepted calls before committing its terminal outcome.
The conversation retains the suffix, observation freezes the result, and chat
returns to its existing reader.

| Component                                | Proposed responsibility                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| Trusted turn controller                  | One run signal, idempotent request, settled promise, listener disposal            |
| Conversation and loop                    | Signal propagation, call accounting, outcome arbitration, no further model steps  |
| Dispatcher and filesystem                | Cooperative checkpoints and settled timeout/cancellation results                  |
| Patch preparation, approval, application | Release review input, stop pre-rename work, preserve committed mutation           |
| Codex transport and credential resolver  | Cancel request/stream, await safe credential cleanup, gate answer callbacks       |
| Line input and CLI                       | One input owner, interrupt routing, approval-read invalidation, follow-up input   |
| Observation and renderer                 | Display request while running, label confirmed cancellation, preserve race winner |

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI / single input owner
    participant Control as Trusted turn controller
    participant Loop as Agent loop
    participant Work as Transport / tool / approval
    participant View as Observation
    CLI->>View: Allocate run record
    CLI->>Control: Register active turn before invocation
    Control->>Loop: Start turn with signal
    Loop->>Work: Await operation with signal
    User->>CLI: Ctrl+C
    CLI->>Control: Request cancellation
    Control->>Loop: Abort signal once
    Loop->>View: run_cancellation_requested
    Loop->>Work: Stop at safe boundary
    Note over Work: Await owned I/O and cleanup
    Work-->>Loop: Settled result
    Loop->>Loop: Account for remaining calls without execution
    Loop-->>Control: Commit one terminal outcome
    Control-->>CLI: Settled turn and conversation suffix
    CLI->>View: Finalize from runtime outcome
    CLI-->>User: Result card, then next yo>
```

## Goals / Non-Goals

**Goals:** Make cancellation a trusted session control with complete evidence and
safe continuation. Preserve exact patch consent, sequential execution, answer
confirmation, and the closed registry. Define races at explicit runtime commit
points rather than deriving outcomes from terminal text.

**Non-Goals:** See [proposal](proposal.md#authorization-and-deferred-scope).
There is no concurrent line-command cancellation, forced termination, remote
provider job deletion, rollback, or new model tool. Cancellation applies to chat
turns, including their credential resolution, not to `yo login` or auth commands.

## Decisions

### 1. Separate cancellation request from settlement

Introduce a small trusted controller module (candidate
`src/runtime/run-controller.ts`) with request, signal, and settled-result access.
Its settled promise adopts the complete turn promise, including cleanup and
conversation construction. Register it before invoking the turn, including
synchronous initial events. Dispose it after settlement; an old controller
cannot affect a newer run. A first request aborts once; duplicates do nothing.
Controller state does not replace runtime outcome.

The direct reference is [pi's session](../../../../../pi/packages/coding-agent/src/core/agent-session.ts):
`abort()` calls `agent.abort()` and then `waitForIdle()`. Yo has no steering
queue, background retry, compaction, or concurrent session operation to cancel.
One controller is sufficient. An observation-owned stop flag would mix display
and execution authority; a promise race returning early would leave work active.

### 2. Extend trusted APIs with optional signals

Add optional signals to turn/loop and transport options and an explicit general
dispatch execution option; keep patch approval/lifecycle options separate.
Thread execution signals into read operations and patch phases. Existing callers
without a signal retain their call syntax; closed model schemas do not change.
Approvers get optional signal options distinct from the immutable proposal view.
No signal, controller, or approval authority enters model context.

Check cancellation before model requests, after awaited model work, before tool
dispatch, and between filesystem awaits/iterations. Non-interruptible Node I/O
must finish before the operation returns. Trusted custom transports/executors
must cooperate or be awaited; returning early is not a fallback.

### 3. Define terminal and operation race boundaries

The loop commits a terminal status/reason once. If a terminal outcome has already
been committed, a later interrupt cannot change it, even while outer cleanup or
result rendering continues. If cancellation was observed before accepting a
model result, discard the response and do not publish a final answer or new calls.
A pre-aborted turn records start and cancellation evidence, retains its user
task, and finishes `aborted` / `aborted` without a model request. Runtime callbacks
after the cancellation gate or terminal commit cannot release answer text.

A response containing calls that was accepted before cancellation is retained.
Keep completed results; await the active call and give every unstarted call one
`aborted` result and `tool_requested`/`tool_completed` evidence in provider order,
without permission evaluation or execution. Then stop; do not ask the model to
acknowledge the cancelled run. A patch approver returning `aborted` without an
aborted run signal still affects only that patch.

For a tool whose execution timer and run signal race, latch the first observed
stop cause: timeout-first yields `timeout`; cancellation-first yields `aborted`.
Await cleanup before returning either. A previously committed success/denial/error
is preserved. The run still cancels if its signal was observed before terminal
commit, regardless of an individual call's timeout or successful patch result.

### 4. Settle read and preparation timeouts too

Replace the detached read/preparation timeout race with a cooperative operation
signal and settled wrapper. A timer requests stop; the wrapper awaits the
execution promise before returning the single timed-out result. This changes the
current prompt timeout return behavior deliberately: five seconds limits active
execution but is not a hard settlement deadline. It avoids maintaining a second
registry of detached reads and ensures the next turn does not overlap old work.

Filesystem loops check the signal before starting the next path/read, and signal
support is used where the existing API supports it. Cleanup failures cannot
cause a second result. Rejection classification uses local Zod `safeParse` for
unknown external shapes, with extra fields allowed, and fixed safe messages.
No broad error-shape heuristics or exposed arbitrary abort reasons are needed.

### 5. Release approval input without another reader

Refactor the existing readline wrapper to retain one persistent interface with
one explicit pending read owner, cancellable read options, and a trusted interrupt
subscription. Do not race `iterator.next()` against a signal and leave the old
iterator consuming future input. Cancelling a pending approval read invalidates
that owner, settles its promise with a typed aborted outcome, clears its partial
line and buffered input received during cancellation, and leaves the interface
available for the next prompt. Each read has identity so a late resolution cannot
approve or submit text for a different read. Lines received during cancellation
are discarded; fresh lines after the next prompt follow ordinary input handling,
even if their text is `y`. Cancellation-first beats a late cancelled-read `y`;
if `y` arrives first, the dispatcher must still check the signal before mutation.

Use the existing readline SIGINT event for an interactive terminal, without a
second key reader. A scoped process SIGINT handler routes to the same controller in non-TTY chat
and remains a fallback in interactive chat after EOF or an input-reset failure
closes readline. Both routes share the idempotent controller; only the first
signal transition resets input. Avoid duplicate effects if both sources fire. During active
work, Ctrl+C requests cancellation and waits; during settlement repeated Ctrl+C
has no force-exit behavior. At an idle prompt, Ctrl+C closes chat cleanly without
a run allocation. Dispose listeners on every exit/failure. Ordinary `/exit`, EOF,
inspection, and non-TTY consent rules stay as specified. EOF while awaiting patch
consent remains denial; it is not an interrupt or cancellation request.

### 6. Compose patch cancellation with its existing mutation boundary

Extend the settled patch-timeout wrapper to accept the run signal while retaining
first-stop-cause classification. Preparation must settle before a cancelled result;
cancelled review produces `approval_resolved: aborted` and cannot later apply.
Revalidation and temporary-file I/O keep their existing checks, plus the combined
signal. Check just before rename. Once rename was initiated, await it: success
remains tool `success` with `patch_applied`, even if cancellation arrived during
rename. The run can then finish cancelled with that application evidence. Do not
undo a prior or just-committed patch; rename failure remains a sanitized operation
error. Existing residual filesystem races and exact-diff consent remain unchanged.

### 7. Cancel transport while preserving credential integrity

Pass the optional signal through credential resolution and authenticated fetch.
Check before/after credential-store operations; use the signal on refresh fetch.
Once a refresh returns a valid rotated credential, allow its already-required
serialized persistence and lock release to settle, even if the run is cancelled.
Then block the model request. Do not leave a partially stored rotated credential
or abandon a credential-store lock. No login browser/callback changes are needed.

Fetch/body reads and SSE parsing share the run signal. On cancellation close the
response reader and await read/reader cleanup; HTTP-error paths also release the
body. Gate confirmed answer callbacks and recheck the signal after parsing so
a late completed response cannot be accepted. Cancellation is classified from
the trusted run signal and commit state, never from unsanitized provider text.
Without cancellation, existing transport error sanitization and completed-answer
fallback remain intact. Local cleanup does not promise remote provider work or
billing reversal.

### 8. Keep display a projection

Record `run_cancellation_requested` through the loop's existing ordered,
snapshot-isolated event machinery. Project a sticky `cancelling` activity and
`cancellation requested` text while the record is running, even if subsequent
tool/patch/finish events arrive. Settle from the returned session. Keep internal
outcome `aborted` and stop reason `aborted`; render this combination as `cancelled`.
Budget exhaustion remains separate. A committed completion remains completed,
and late requests/events cannot mutate retained history or frozen timing.

Display/clock/diagnostic failures cannot block cancellation or approve a patch.
Partial confirmed text already emitted is not erased or upgraded into a completed
answer on cancellation. Preserve renderer cleanup and next-turn independence.

## Risks / Trade-offs

- Non-cooperative I/O may delay settlement → stay in cancellation-requested state;
  test with held promises and never release a follow-up turn early.
- Settled timeout returns can be slower than current timeout returns → explicitly
  revise the tool contract and timing tests; retain timeout classification.
- Interrupted approval input may leak to a later read → explicit owner identity,
  invalidation, clearing input received during cancellation, and late-`y` tests.
- Rename can finish after the request → preserve applied evidence and file bytes;
  test both sides of the pre-rename boundary.
- Credential rotation can outlive cancellation → finish serialized persistence
  and release the lock before settlement; prevent subsequent model fetch.
- Ctrl+C delivery differs in TTY/non-TTY → test both routes, then perform physical
  TTY verification; faux output alone does not establish terminal key behavior.

## Migration Plan

Implement the independently verifiable leaves in [tasks](tasks.md), beginning
with controller/contracts only after bounded confirmation. Each leaf requires
focused tests, relevant checks, and recorded review before completion. Group 1
does not wire Ctrl+C or claim user-visible cancellation. No stored-data migration
is needed. Keep main specs unchanged until verified behavior is accepted; closure
then synchronizes deltas, archives evidence, and updates the project maps.

## Validation

Use controlled promises and injected filesystem/fetch/input operations to test
pre-abort, model fetch/SSE and credential work, read timeout draining, pending
approval, patch temporary I/O, successful/failing rename, between-call stops,
duplicate requests, both terminal race orders, and late callbacks. Assert exact
call IDs/order/results, no later model request, no pending reader stealing input,
no write without consent, and no changes to settled run records. Run CLI flows
for cancellation → `/runs` → `/run N` → fresh task in TTY and non-TTY presentation;
verify physical Ctrl+C and patch-review recovery separately from faux evidence.
Use `npm test`, `npm run build`, `npm run format:check`, `npm run spec:check`, and
`git diff --check` for implementation closure. Planning-only validation is
structural, coverage/link/format checking and self-review, not runtime proof or
human acceptance.
