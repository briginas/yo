# Verification

## Current status: group 2

On 2026-10-02 the user explicitly requested the next bounded step in a separate
subagent: “и делай след шаг в отдельном субагенте”. The next candidate in the map
was group 2, so this authorizes tasks 2.1–2.3 only. Group 1 had been committed as
`7a79dfa` before this work. Groups 1–2 now have scoped checks and agent review;
human acceptance of the group 2 result remains pending. No later group, main-spec
synchronization, archive, or full-feature completion is inferred.

### Settled operation and race boundary

The internal [settled wrapper](../../../src/runtime/settled-operation.ts) replaces
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

The internal [controller](../../../src/runtime/run-controller.ts) accepts one
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
