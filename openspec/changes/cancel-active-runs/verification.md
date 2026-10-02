# Verification

## Current status: group 1

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
requirement was changed. The group 1 section above records subsequent bounded
authorization and implementation checks separately from this planning evidence.
