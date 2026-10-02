# Verification

## Current status: accepted, synchronized, and archived

Groups 1–7 and integration tasks 8.1–8.2 are implemented, verified, and
agent-reviewed. The user authorized implementation with a commit after each step;
group 5 is committed as `3a4406f`, group 6 as `c67c608`, group 7 as `5aae91e`,
and final integration verification with the observation reentry fix as `755d9c9`.
The user then explicitly accepted the verified result and authorized closure
with “it's ok. go” on 2026-10-02. The five main specs now contain the implemented
verified deltas, and this change is archived. Earlier group sections below
retain their status at the time of each check; their pending-acceptance notes
are historical.

### Task 8.3 closure

The agent-driven sync added 11 requirements and modified 8 across agent harness,
CLI chat, Codex authentication/transport, approval-gated patching, and run
observation. Comparison against the original specs confirmed unchanged titles,
Purpose sections, unrelated requirements and scenarios, and an idempotent merge.
Strict validation passed for all five main specifications before archive.
The pinned CLI archived with `--skip-specs` after that verified sync; it did not
perform a second merge. Project maps and moved relative links were updated.
Independent read-only closure review found no concrete issues and confirmed all
19 delta requirements, scenario preservation, consistent acceptance status,
correct moved links, and unchanged capability/consent boundaries. Task 8.3 is
complete after that review and the scoped checks below; all 24 tasks are checked.
The validation draft is byte-for-byte unchanged; explicit rerun planning and
validation remain unapproved. This closure changes documentation only and does
not claim new runtime, physical-keyboard, or live-provider testing.

- `npm run spec:check`: 6 passed, 0 failed (five current specs and the remaining
  unapproved validation draft); requirement-length hints remain informational.
- `npm run format:check` and `git diff --check` passed.
- All 76 local Markdown links across 17 scoped files resolve; no project-map
  reference remains to the old active cancellation path.
- The five archived deltas and archive metadata match their pre-archive bytes.
  Hash comparison confirms the entire validation draft is unchanged.
- A second semantic merge leaves no changes to apply; unrelated requirements
  and scenarios, existing titles, and Purpose sections retain their original text.

### Final integration and review

The [cancellation demo](../../../../examples/run-cancellation-demo.ts) uses real
CLI composition, native readline, a temporary fixture, and a faux model. Its
[captured transcript](../../../../examples/run-cancellation-demo.txt) shows a real
read followed by held model cleanup, one request despite repeated interrupts,
requested activity before settlement, cancellation of pending exact review,
discarded partial/late consent, fresh proposal and consent, successful application,
and unchanged inspection of the cancelled runs afterwards. Two generated runs
matched byte-for-byte; the parent rerun matched the committed transcript. The
existing observation demonstration still matches its captured transcript too.

Final cross-component review found a clock-diagnostic reentry gap: nested
cancellation could be projected while the outer event held an older record,
then erased by the outer save. Entire observation updates and settlement are
now serialized in one synchronous queue. Trusted cancellation remains immediate;
projection and display preserve event order without stale overwrites. New tests
cover diagnostic-triggered cancellation, completion/failure settlement winning,
frozen timing, and next-run identity. Independent review reproduced the fix and
reported no remaining concrete lifecycle issue. These reviews are agent evidence,
not human acceptance.

### Terminal and provider coverage

- Real PTY with native readline and a faux provider: repeated Ctrl+C at pending
  model work produced one request and cancelled settlement; `/runs` and `/run 1`
  retained the completed read and no final answer. During patch review, partial
  `y`, Ctrl+C, and late `y` produced aborted review with no application. The next
  proposal still previewed 42→43 and required fresh `y`, then recorded application
  and completion. `/run 2` retained the original cancelled trail. Exit code was 0.
- Separate real PTY: idle Ctrl+C exited with code 0 and no run allocation.
- Separate real PTY: Ctrl+D during model work closed readline without cancelling;
  subsequent Ctrl+C reached actual process SIGINT, settled cancelled, and exited 0.
- Real non-TTY child process: repeated OS SIGINT produced one request, awaited
  model cleanup, rendered cancelled, suppressed its late answer, emitted no ANSI
  controls, and exited 0. No patch consent was granted.
- PTY input was tool-driven. A human physical keyboard/terminal-emulator check
  and live-provider/billing behavior were not verified. No OAuth credential or
  network/model request was used for these checks. The demo uses durable progress
  lines; actual cursor replacement remains covered by renderer tests.

### Final checks and scenario coverage

- `npm test`: 466 passed, 0 failed, skipped, or cancelled (27 suites).
- `npm run build`: strict TypeScript and CLI bundling passed.
- `npm run format:check`, `npm run spec:check` (7 passed, 0 failed), and
  `git diff --check` passed. Existing main-spec length hints are informational.
- Demo syntax/format checks passed; deterministic transcript comparisons passed.
- Local Markdown links in maps, contribution guide, and active change passed.

| Delta                   | Verified behavior and principal tests                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| agent-harness           | Controller isolation, settled read timeouts/first stop cause, pre-abort, accepted call accounting, late responses, terminal commit orders: run-controller, settled-operation, filesystem, tool-dispatcher, agent-loop-cancellation tests         |
| cli-chat                | Single input ownership, pending review release, TTY/process/EOF routing, held cleanup, inspection, retained suffix, fresh budget and callback isolation: line-input, cli-cancellation, conversation/agent-loop-cancellation tests and PTY checks |
| codex-auth-transport    | Held store/refresh/persistence and lock release, no later model fetch, reader/body cleanup, HTTP errors, partial/late answer gates, unchanged sanitization: request-cancellation and existing auth/provider tests                                |
| approval-gated-patching | Preparation/review cancellation, both consent orders, no pre-rename mutation, initiated rename success/failure, applied evidence and fresh consent: patch-cancellation/application/approval tests, loop tests and demo                           |
| run-observation         | Request versus settlement, sticky activity, exact labels, frozen timing/history, applied trails, faulty consumers and reentrant clock/diagnostic/renderer paths: observation/terminal tests, CLI tests and demo                                  |

No new dependency, model tool/schema, credential configuration, login capability,
process tool, rerun, validation, rollback, automatic retry, or persistence was
added. Non-cooperative owned work still delays settlement; requesting cancellation
is not a hard elapsed-time guarantee. Rerun and allowlisted validation remain
separate unapproved work. Specification synchronization/archive are recorded above.

## Group 7 evidence (before integration verification)

Groups 1–7 are implemented, checked, and agent-reviewed under the user's request
to implement the change and commit after each step. Group 6 is committed as
`c67c608`. Human result acceptance and specification synchronization/archive
remain pending. Main specifications are unchanged.

The CLI registers its trusted controller before turn invocation and initial
observation rendering. Active Ctrl+C requests cancellation and awaits the complete
turn; repeated requests neither reset input again nor force termination. Idle
interrupt closes chat without allocating a run. Process SIGINT is scoped to chat,
with readline supplying the interactive key route. Independent review identified
that interactive EOF/reset failure removes readline's route while work may remain
active; a process fallback now remains installed in interactive chat too. Both
routes share the same controller and are disposed on all chat exits. EOF itself
remains ordinary denial/exit, not cancellation.

The reader exposes a trusted discard-until-next-read boundary, including partial
input and queued lines when no approval read is pending or EOF already occurred.
Pending approval cancellation still releases ownership, rejects late consent,
and requires fresh input after settlement. The CLI never reads another task or
inspection command before the complete turn settles.

Observation projects one request row and sticky cancelling activity, retaining
subsequent tool/patch/finish evidence while unsettled. Only runtime aborted/aborted
renders cancelled; internal outcomes stay aborted, and completion/budget are
preserved. A synchronous notification queue prevents reentrant terminal or answer
callbacks from rendering nested cancellation before an older row or overwriting
its activity. Each observer/display failure remains isolated. Frozen history,
timing, applied patch evidence, and run identity remain unchanged after settlement.

- Combined input/CLI/observation/renderer suite: 157 passed, 0 failed.
- Eleven new CLI scenarios cover held cleanup, repeated interruption, inspection
  and fresh context, synchronous initial interruption, committed completion while
  outer settlement waits, native readline approval interruption/late consent,
  idle interruption, failure/disposal, display/clock/diagnostic failure, EOF fallback,
  and real process-listener installation/disposal without sending process signals.
- Input tests verify discard with no pending approval, pending owner release, EOF,
  partial/buffered text, and fresh reads. Observation tests cover sticky activity,
  duplicate evidence, actual settlement labels, frozen/applied trails, faulty hooks,
  and both terminal-writer and answer-observer reentry.
- `npm run build`, formatting, strict OpenSpec validation, and diff checks passed.
- Implementation subagents and parent reviewed tests and final code. Independent
  CLI/input review confirmed the EOF route fix and reported no remaining defect.

Faux/native stream tests do not establish physical terminal key behavior. Group 8
will verify a real PTY separately, add a deterministic example, and run full checks.
No live-provider request was performed. Rerun/validation remain separate work.

## Group 6 evidence (before group 7)

Remaining implementation is authorized with a commit after each step. Group 5
is committed as `3a4406f`. Groups 1–6 are checked and agent-reviewed; result
acceptance and synchronization/archive remain pending.

The loop now forwards the signal, emits one frozen ordered cancellation-request
event, waits for active work, and discards responses after its cancellation gate.
Accepted call batches retain completed/active outcomes and receive ordered aborted
results for unstarted calls without dispatch or permission checks. No later model
step runs. A terminal outcome commits before final-answer/finish observers;
later interrupts preserve completion. Approval-only abort remains call-local,
and applied patches retain their success and application evidence.

Answer callbacks close per request and after terminal settlement, preventing stale
step/turn callbacks from adding text. Confirmed partial output remains evidence
with no fabricated final answer. Conversation passes the signal and appends the
cancelled suffix once; a fresh turn has fresh budgets and retained structured data.

- Focused loop/conversation suite: 51 passed, 0 failed, including twelve new
  top-level cancellation tests with race variants.
- `npm run build`, formatting, strict specification validation, and diff checks passed.
- Implementation subagent review and independent review covered reentrant observer
  cancellation, terminal arbitration, accepted-call accounting, callback lifetime,
  signal disposal, and sanitized unexpected dispatch errors. Independent review
  found an unguarded clone of unvalidated unknown arguments; it was removed and a
  non-cloneable malformed-argument regression now produces invalid_arguments and
  terminal evidence. An outer finally removes signal listeners on exceptional exits.
- Parent reviewed the final loop, conversation, and test diff; no scoped issue remains.

CLI interrupts and cancellation presentation are the next authorized group. No
physical TTY/live-provider check was performed; main specifications remain unchanged.

## Group 5 evidence (before group 6)

On 2026-10-02 the user requested implementation of `cancel-active-runs` with a
commit after each step, authorizing the remaining implementation groups in order.
They also authorized useful subagents. Group 4 is committed as `20d2371`.
Groups 1–5 are implemented and verified. Human result acceptance and task 8.3
specification synchronization/archive remain pending; checks do not supply acceptance.

### Request and credential settlement

Optional run signals now reach credential reads, the serialized refresh callback,
refresh fetch, model fetch, and SSE consumption. Pre-abort starts no store/fetch
work. Store reads and lock waits remain awaited, with checks before further work.
A valid rotated credential returned by refresh is validated and persisted before
`modify` releases its lock; cancellation is then reported without a model fetch.
Login/callback command behavior and model-visible schemas are unchanged.

SSE abort cancels its reader to release a pending read, awaits cancellation and
releases the lock before return. HTTP-error and late-fetch bodies are released.
Every confirmed answer callback is signal-gated, and completion is rechecked
through cleanup. Already delivered confirmed partial text is preserved. Fixed
cancellation errors never expose arbitrary abort reasons or provider payloads.

### Scoped checks and review

- Auth/provider focused suite: 92 passed, 0 failed. Twelve new controlled tests
  cover pre-abort, held read/lock/refresh/persistence, lock release, rotated-token
  persistence, fetch abort/rejection/late response cleanup, held SSE cleanup,
  partial confirmed callbacks, completed-response cleanup races, and HTTP errors.
- `npm run build` passed strict TypeScript and bundling.
- Independent subagent review found no implementation defect. Existing HTTP-error
  tests were updated to expect the required body release (`bodyUsed: true`).
- Formatting, strict OpenSpec validation, and diff checks passed before commit.

No physical TTY or live-provider check was performed. Loop/conversation/CLI
cancellation wiring remains the next authorized group. Main specs remain unchanged.

## Group 4 evidence (before group 5)

On 2026-10-02 the user again requested “коммить и делай след шаг в отдельном
субагенте”. The ready group 3 was committed as `c77cdf9`; the next bounded
candidate was group 4, so this authorizes tasks 4.1–4.3 only in a separate
subagent. Groups 1–4 have scoped checks and agent review. Human acceptance of
the group 4 result remains pending. Later groups, full-feature completion,
main-spec synchronization, and archive are not authorized by these checks.

### Patch signal and consent boundaries

The specialized [dispatcher](../../../../src/runtime/tool-dispatcher.ts) now forwards
the optional execution signal through settled preparation, trusted review, and
application. Approval receives the signal separately from its immutable complete
view; a cancelled review is awaited, resolves `aborted`, and cannot reuse late
consent. A cancellation after accepted approval is checked before application,
even when raised by the approval-resolved lifecycle observer. No approval timeout
was added. Approval-only abort still affects just that call; a later proposal
requires fresh consent.

Preparation stopped before commitment emits no approval trail. Once preparation
has committed, the dispatcher retains prepared/requested/resolved evidence. If
cancellation occurs during permission/prepared notification before review starts,
requesting review records an aborted decision without invoking the approver or
showing a prompt. This attempted-review trail supplies no consent. Pending review
produces one resolved-aborted event after its owned work settles. Each dispatch
returns one result with its original call identifier. Tool-requested/completed
run events remain owned by the unchanged loop; group 4 introduces no new loop
accounting or whole-run outcome.

### Settled application and atomic replacement

[Application](../../../../src/runtime/patch-applier.ts) combines external cancellation
and its existing execution timer with the first observed stop-cause latch. The
combined signal reaches path revalidation (component lstat/canonical realpath)
and the shared bounded source reader, including awaited handle close. Checks
between temporary open/chmod/write/sync/close and immediately before rename
prevent further work after a stop. Temporary I/O, close, and existing best-effort
cleanup remain owned and awaited; timeout is an execution bound, not an immediate
settlement deadline.

Before rename, a stop observed before accepting an I/O result/failure yields a
stopped outcome, classified as `timeout` or `aborted` by the first cause. An
already accepted conflict or error is committed inside application before its
`finally` cleanup; a later stop during cleanup or outer settlement does not
relabel it. The wrapper classifies only stopped outcomes and removes its signal
listener and timer on all exits.

Once rename is initiated, its actual settled outcome wins. Successful native
replacement remains `success` with one applied event and the exact approved
bytes, even when cancellation and timeout arrive while rename is pending.
Failing initiated rename remains a fixed sanitized execution error, including
an injected error labelled aborted; cleanup is awaited and no applied evidence
or rollback is fabricated. Application does not undo an earlier patch or create
additional write authority.

### Scoped checks and review

- Focused patch-cancellation/application/preparation/approval/dispatcher/transform/
  runtime-barrel suite: 73 passed, 0 failed. The 17 new cancellation tests cover
  held review with late consent and review outside the timer, accepted consent
  followed by cancellation, prepared-notification cancellation with no prompt,
  fresh consent after denied/approval-only-aborted calls, both stop-cause orders
  through real temporary writing/close/unlink, acquired source-read close, nested
  path checkpoint propagation, committed errors during held cleanup, listener
  disposal and later cancellation after success/conflict/error, pre-abort, and
  successful or failing initiated rename with byte/event agreement.
- `npm test`: 407 passed, 0 failed, 0 skipped, 0 cancelled (27 suites).
- `npm run build`: strict TypeScript checks and CLI bundle passed.
- `npm run format:check`, `npm run spec:check` (7 items, 0 failures), and
  `git diff --check` passed. Existing main-spec informational length hints remain.
- Local Markdown link checks passed for all 47 references in the project maps
  and change artifacts.
- Subagent self-review covered first-stop classification versus application
  commit, rename-start arbitration, awaited I/O/cleanup, signal propagation
  through revalidation, skipped/pending review trails, safe output and fixed
  rename error text, optional no-signal compatibility, exact consent, and unchanged
  runtime registry. Parent review found and confirmed the fix for typed-abort
  rename failure and reviewed the patch and native byte/lifecycle tests. These
  are agent reviews, not human acceptance. Group 4 changes remain uncommitted
  for result review.

No physical TTY or live-provider cancellation check was performed. Loop,
conversation, transport, CLI interrupts, and observation remain unwired. Main
specifications remain unchanged. The next candidate is group 5, signal-aware
Codex request and credential work, after separate bounded confirmation.

## Group 3 evidence (before group 4)

On 2026-10-02 the user requested “коммить и делай след шаг в отдельном
субагенте”. The ready group 2 was committed as `b061aee`; the next bounded
candidate was group 3, so that instruction authorizes tasks 3.1–3.3 only in a
separate subagent. Groups 1–3 have scoped implementation checks and agent review.
Human acceptance of the group 3 result remains pending. Later groups, full-feature
completion, main-spec synchronization, and archive are not authorized by these
checks.

### Input ownership and lifecycle

The single [line reader](../../../../src/line-input.ts) now uses explicit line events,
a queue for ordinary buffered input, and one pending owner identity. It creates
no async iterator or competing reader. Optional read signals reject a cancelled
owner with the fixed typed `LineReadAbortedError`; ownership and the abort listener
are released before clearing input. A resolved/invalidated owner cannot consume
a new read or cancel it later. Concurrent reads are rejected.

Cancellation discards queued lines, clears the existing partial input, and ignores
new lines until the next prompt. Before that prompt it clears any partial input
received during cancellation too. Normal TTY editing clears both sides of the
cursor through public readline keys; `TERM=dumb` uses Return as a discard-mode
flush when editing keys leave text. Non-TTY uses public `write('\n')` to flush
readline's internal partial buffer into discard mode. Fresh input after the new
prompt keeps ordinary handling, including the text `y`.

Ordinary EOF drains queued complete lines and the final partial line; explicit
close releases a pending owner, discards memory, and removes input/interrupt
listeners. Input errors reject pending work and remain errors for a later read
until explicit close. Reset display failure cannot leave cancellation pending:
its owner is already aborted and the unsafe reader closes with a fixed input-reset
error. No private readline buffer is accessed.

Optional `subscribeInterrupt` observes the existing interactive readline SIGINT
route and returns an idempotent disposer. A throwing observer does not prevent
another subscriber or input cleanup. Without subscribers, Ctrl+C retains the
prior readline close behavior. No process SIGINT handler or active run controller
is connected yet; that is group 7.

### Exact approval and race boundary

[Trusted approval](../../../../src/runtime/patch-approval.ts) passes optional signal
options separately from its detached frozen view. The
[terminal approver](../../../../src/terminal-approval.ts) forwards the signal to its
borrowed line read. Pre-abort skips review; cancellation observed before accepting
pending consent returns `aborted`, including a late affirmative read or approver
settlement. The decision commits when the awaited result is accepted; cancellation
after a committed approval cannot change that returned decision. A custom
non-cooperative reader/approver remains awaited through its settlement, and its
late consent is discarded instead of racing detached work.

Typed read cancellation is `aborted` even without a whole-run signal. EOF,
ordinary input errors, invalid answers, absent approval, and non-TTY input retain
denial semantics. Complete previews and fresh exact consent are preserved.
Signal/control options and approval text never enter the approval view or model
messages. Existing dispatcher/loop/conversation code is unchanged: approval-only
abort still affects just its patch call. Run signal propagation into review and
application remains group 4; active chat cancellation remains groups 6–7.

### Scoped checks and review

- Focused input/terminal/trusted approval suite: 32 passed, 0 failed. Covers
  pre-abort, owner release and stale signal isolation, both consent/cancellation
  orders, late affirmative settlement, normal buffered non-TTY/EOF behavior,
  partial input discard in TTY and non-TTY, moved cursor suffix, fresh `y`,
  input errors, explicit close/listener disposal, interrupt unsubscribe/default
  close/throwing observer, immutable views, full preview, non-TTY no-read, and
  reset display failure.
- `npm test`: 390 passed, 0 failed, 0 skipped, 0 cancelled (27 suites).
- `npm run build`: strict TypeScript checks and CLI bundle passed.
- `npm run format:check`, `npm run spec:check` (7 items, 0 failures), and
  `git diff --check` passed. Existing main-spec informational length hints remain.
- Local Markdown links in project maps and change artifacts passed.
- Subagent self-review covered pending identity invalidation before display work,
  ordinary EOF queue draining, cancellation discard lifetime, public partial-buffer
  reset, signal cleanup, approval acceptance checks, unchanged frozen preview,
  and the absence of dispatcher/CLI wiring. Parent review feedback identified
  default SIGINT behavior, cursor suffix, and reset display failure cases; these
  were addressed and tested. The parent reviewed the final runtime/test diff
  and reported no remaining substantive issue. Agent review does not imply human
  acceptance. Group 3 changes remain uncommitted for user review.

No physical TTY or live-provider cancellation check was performed; faux terminal
streams verify these bounded APIs only. Main specifications remain unchanged.
The next candidate is group 4, patch cancellation and atomic replacement, after
separate bounded confirmation.

## Group 2 evidence (before group 3)

On 2026-10-02 the user explicitly requested the next bounded step in a separate
subagent: “и делай след шаг в отдельном субагенте”. The next candidate in the map
was group 2, so this authorizes tasks 2.1–2.3 only. Group 1 had been committed as
`7a79dfa` before this work. Groups 1–2 now have scoped checks and agent review;
human acceptance of the group 2 result remains pending. No later group, main-spec
synchronization, archive, or full-feature completion is inferred.

### Settled operation and race boundary

The internal [settled wrapper](../../../../src/runtime/settled-operation.ts) replaces
read/preparation `Promise.race` with one awaited operation. Its internal signal
combines external cancellation and the execution timer. The first observed stop
cause is latched: timer first returns `timeout`; external cancellation first
returns `aborted`. Subsequent stop requests cannot change it. Even an operation
that ignores abort must settle, including its owned cleanup, before the wrapper
returns. A late success or rejection after a stop produces the same single stopped
outcome, including a cleanup rejection; it cannot publish a second result.

The ordinary success/denial/rejection commits when the awaited complete operation
settlement is observed by the wrapper. A stop before that point wins. Later stop
requests cannot relabel the committed outcome. The wrapper removes the external
abort listener and clears the timer on every exit. A pre-aborted signal invokes no
operation. Abort output uses a fixed message, never arbitrary `signal.reason`.

Dispatcher authorization is signal-aware and awaited without an execution timer,
preserving its original timing boundary. Allowed read execution and patch
preparation retain the configured execution timeout. No-signal callers now also
wait for stopped read/preparation I/O to settle: the timer bounds execution, not
the time at which a fully settled result must return. Non-cooperative I/O can
therefore delay the next sequential operation.

### Filesystem and preparation boundaries

Signals pass through repeated lexical/canonical read authorization, list/search/
read operations, and patch preparation. Checks before/after awaits prevent another
path, candidate, or read from starting after cancellation. Native `readFile` gets
the signal; non-interruptible stat/realpath/readdir/open/handle-read work remains
awaited. The bounded patch reader closes an acquired handle in awaited `finally`,
even when cancellation arrives while opening or reading. Target policy, symlink
checks, file/output limits, exact transforms, and model schemas are preserved.

Trusted filesystem operation injection and the internal bounded-reader export
exist for controlled tests only; the runtime barrel value exports and four-tool
registry are unchanged. Signals are optional, outside model arguments. Patch
dispatch honors the external signal during preparation only at this stage.
Cancellation after completed preparation, approval waiting, and application still
need group 4 wiring; approval input ownership is group 3. The loop, conversation,
transport, CLI interrupt handling, and observation are not yet wired. This is not
evidence of user-visible whole-turn cancellation.

### Scoped checks and review

- Focused wrapper/dispatcher/filesystem/workspace/preparation/application/barrel
  suite: 85 passed, 0 failed. Includes native fixture policy/output regression
  checks and controlled work, cleanup, both stop orders, prior settled outcomes,
  pre-abort, untimed authorization cancellation, recursive traversal/candidate
  stops, preparation I/O checkpoints, no cancelled-preparation approval trail,
  and acquired-handle close ownership during held open/read/close.
- Wrapper suite: 8 passed after strengthening the cleanup-rejection scenario.
- `npm test`: 371 passed, 0 failed, 0 skipped, 0 cancelled (27 suites).
- `npm run build`: strict TypeScript checks and CLI bundle passed.
- `npm run format:check`, `npm run spec:check` (7 items, 0 failures), and
  `git diff --check` passed. Existing main-spec informational length hints remain.
- Agent self-review covered first-stop arbitration, settlement through cleanup,
  commit/disposal boundaries, no detached I/O, optional argument compatibility,
  safe abort text, unchanged permission/output/consent boundaries, and separation
  from groups 3–8. The parent agent also reviewed runtime and test diffs, with no
  substantive issue reported; a cleanup-test title mismatch was resolved by
  explicitly rejecting cleanup in that scenario. This is agent review evidence,
  not human acceptance.

No physical TTY or live-provider cancellation verification was performed; those
paths remain unwired. Main specifications were not synchronized. The next bounded
candidate is group 3, cancellable input and patch review ownership, requiring
separate confirmation.

## Group 1 evidence (before group 2)

The user confirmed the bounded group 1 implementation on 2026-10-02 with
“ок. делай” after presentation of controller and signal-contract scope. Tasks
1.1–1.3 are implemented, checked, and self-reviewed. Human acceptance of the
implementation result remains pending; no later group, full cancellation feature,
spec synchronization, or archive is approved or complete.

### Controller and API boundaries

The internal [controller](../../../../src/runtime/run-controller.ts) accepts one
trusted operation callback, gives it one owned `AbortSignal`, and exposes
`requestCancellation()`, `settled`, and `dispose()`. Invocation starts in the
next microtask, allowing the owner to register the controller before synchronous
runtime events and request cancellation before work begins. The callback still
receives the pre-aborted signal so future loop integration can record the task
and aborted outcome without requesting the model.

Cancellation aborts once and does not resolve or reject settlement. The settled
promise adopts the complete callback result or rejection, including callback
cleanup and conversation construction. It never infers a run outcome from the
signal. Requests close automatically on fulfillment/rejection; explicit disposal
is idempotent and only closes the request path. Disposal does not abort, detach,
or finish owned work. Each controller owns a distinct signal and cannot act on
another run. It creates no timer, input reader, process handler, or external
signal subscription needing disposal.

Optional `signal` fields are declared on `RunAgentOptions`,
`RunConversationTurnOptions`, and `ModelTransportOptions`. `ToolExecutionOptions`
is an optional sixth dispatcher argument, separate from existing patch options.
`PatchApproverOptions` is an optional second callback argument, separate from the
immutable approval view. The two new option types are exported through the
runtime barrel; the controller remains internal and runtime value exports are
unchanged. `run_cancellation_requested` has only its event discriminator, with
no raw abort reason or diagnostic payload.

These are contract declarations only: the loop, conversation, dispatcher,
transport, and approver do not yet propagate or honor those new signal options.
The new event is not yet emitted or projected. CLI Ctrl+C behavior, settled read
timeouts, patch consent, provider requests, and model-visible tool schemas remain
the existing implemented behavior. Do not use group 1 readiness as evidence that
a real chat turn can already be cancelled.

### Scoped verification and self-review

- Controller tests: 8 passed, covering owner registration/pre-start cancellation,
  repeated requests, held operation and cleanup, preserved completed result,
  rejected and synchronous-throw invocation, stale controller isolation, and
  idempotent disposal without detached work.
- Focused controller/runtime API/model-contract/tool-schema/patch-schema tests:
  23 passed. Existing exact runtime value exports and tool boundaries passed.
- `npm test`: 349 passed, 0 failed, 0 skipped, 0 cancelled.
- `npm run build`: strict TypeScript checks and CLI bundling passed; existing
  no-signal callers remain compatible.
- `npm run format:check`, `npm run spec:check`, and `git diff --check` passed.
- Self-review checked the single callback invocation, signal ownership,
  full-promise adoption, request disposal on both terminal promise paths, absence
  of outcome synthesis or promise racing, optional-argument compatibility, and
  unchanged tool registry/consent boundaries. No scoped issue remained. This is
  agent review evidence, not human implementation acceptance.

No physical TTY or live-provider cancellation check was performed: group 1 has
no terminal/provider wiring. Main specifications remain unchanged. The next
bounded candidate is group 2, settled read and preparation operations, after
separate confirmation.

## Planning status (before implementation)

Planning was prepared and self-reviewed on 2026-10-02. At planning closure runtime
implementation had not started, all 24 tasks were unchecked, and group 1 was the
first candidate for confirmation. Planning checks did not claim any task-group
implementation, human acceptance, spec synchronization, or feature completion.

## Checks

- `npm run spec:check` passed: 7 items, 0 failures, including this change. Existing
  main-spec long-description informational hints remain; no main spec was edited.
- `npm run format:check` and `git diff --check` passed.
- Local link checks passed for the project maps and change artifacts, including
  the inspected pi session reference. A wrong relative pi link was corrected.
- Coverage/structure checks found 5 capability deltas, 19 requirements, and 49
  scenarios. Every modified block retains its original scenario headings; the
  timed-out-read scenario was revised to the proposed settled-return contract.
  Added requirement descriptions meet the 500-character guideline.
- OpenSpec reports all 4 planning artifact categories complete. Its status is
  artifact availability, not implementation completion or approval.

## Coverage review

| Behavior                                                      | Specification delta                 | Task groups |
| ------------------------------------------------------------- | ----------------------------------- | ----------- |
| Trusted request, pre-abort, repeats, stale controller         | agent-harness                       | 1, 6, 7     |
| Await operation cleanup; timeout/cancellation ordering        | agent-harness                       | 2, 4, 6     |
| Accepted call accounting and both terminal race orders        | agent-harness                       | 6, 7        |
| Single reader, cancelled review ownership, late consent       | cli-chat; approval-gated-patching   | 3, 4, 7     |
| Pending preparation, temporary I/O, successful/failing rename | approval-gated-patching             | 2, 4, 6     |
| Credential resolution/rotation, fetch, SSE/body cleanup       | codex-auth-transport                | 5           |
| Confirmed partial text and late answer gating                 | codex-auth-transport; agent-harness | 5, 6, 7     |
| Requested versus settled state, inspection, frozen history    | run-observation                     | 7, 8        |
| Ctrl+C in TTY/non-TTY, idle exit, follow-up, disposal         | cli-chat                            | 3, 7, 8     |
| Full regression, demonstration, reviewed closure              | All five deltas                     | 8           |

The proposal, design, deltas, and tasks agree on Ctrl+C as a trusted control,
separate request and settlement, no further work after cancellation, exactly one
result per accepted call, and preserved committed patches and terminal outcomes.
The design deliberately revises detached read/preparation timeouts and makes
that latency trade-off explicit. A cancelled read's late resolution is distinct
from a fresh user line after the next prompt, which keeps ordinary chat handling.

## Evidence boundaries

Source inspection covered turn/loop/dispatch, read and patch operations, line
input and terminal approval, CLI composition, transport/credential resolution,
observation, nearby tests, and pi's `abort()` / `waitForIdle()` implementation.
At that planning stage no new tests, build, physical TTY, or live-provider check
was run and no code, dependency, model tool, permission, credential, or current
requirement was changed. The implementation sections above record subsequent bounded
authorization and implementation checks separately from this planning evidence.
