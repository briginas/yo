# Verification: Explicit rerun of settled runs

## Authorization and coverage boundary

On 2026-10-03 the user requested the planning artifacts and selected current
conversation context. After the first implementation candidate was presented,
the user's “ok. continue” authorized **group 1 only**: pure parser, trusted task
catalog, action receipts, focused tests, and this evidence.

The later instruction grants explicit standing approval for every remaining
task of this bounded rerun change, including closure tasks 6.1–6.3, with one
subagent and commit per task. [Task 6.1](#task-61-standing-human-approval-and-accepted-scope)
records its exact wording and application to the verified result. It supersedes
the earlier plan to wait for a separate post-implementation acceptance reply.
The later allowlisted-validation draft remains unapproved.

CLI rerun is enabled and groups 1–5 are implemented, checked, and agent-reviewed.
Earlier sections retain historical checkpoint scope; tasks 5.1–5.3 record the
integrated demonstration, real local PTY evidence, full checks, and final
requirement review. Task 6.1 records acceptance of the bounded verified scope
under explicit standing human approval, rather than from automated checks or
agent review. Tasks 6.2 and 6.3 below record specification synchronization and
archive closure. No personal human review of the completed checks,
physical-keyboard or live-provider coverage is claimed.

## Group 1 staged checks and review

### Task 1.1: Pure parser

- Added `src/rerun-command.ts` and its adjacent tests without importing execution,
  observation, filesystem, input, or provider code.
- `node --test src/rerun-command.test.ts`: **3 passed, 0 failed**.
- Coverage includes canonical positive safe numbers through `MAX_SAFE_INTEGER`,
  whitespace/tab variants, all malformed forms in the delta, numeric overflow,
  nondecimal input, and preservation of ordinary/existing command tokens.
- Agent review: matches existing local-command grammar; returns classifications
  only and cannot allocate a run, normalize ordinary task content, or invoke work.
  No review finding required a fix at this step.

### Task 1.2: Trusted attempt catalog

- Added `src/chat-runs.ts` and its adjacent tests. A new catalog starts at 1;
  `firstRunId` is a programmatic allocator test seam to exercise safe-integer
  exhaustion without trillions of reservations, not a CLI/runtime setting.
- `node --test src/chat-runs.test.ts`: **7 passed, 0 failed** at this stage.
- `npm run build`: passed strict TypeScript checking and CLI bundling.
- Coverage includes independent session catalogs, ordinary repeated tasks,
  missing/unsettled/invalid sources, all four valid terminal pairs, exact long
  whitespace/Unicode task text, direct rerun chains, frozen detached snapshots,
  invalid settlement pairs, extra session fields excluded from retained outcome,
  idempotent settlement, and allocation through the maximum safe number.
- Agent review: the catalog has no I/O, callbacks, observer imports, transport,
  or consent objects. Settlement uses a local Zod schema and retains only the
  terminal pair. Returned snapshots cannot rewrite the source. Boundary tests
  confirmed failed reservations consume no number. No fix was needed.

### Task 1.3: Action receipts

- Final `reserveRerun(sourceId, windowId)` reserves one attempt for each numeric
  pair. Window 0 permits initial buffered input; later windows must be nonnegative
  safe integers supplied by trusted input ownership in subsequent work.
- Receipts live for the catalog/session lifetime. Repeat delivery returns a
  detached snapshot of the original accepted attempt, including its settled
  outcome when applicable. Failed reservations create no receipt or run number.
- `node --test src/rerun-command.test.ts src/chat-runs.test.ts`: **14 passed,
  0 failed** (3 parser tests and 11 catalog tests).
- `npm run build`: passed after the receipt API and its tests were added.
- Coverage includes immediate duplicate acceptance, duplicate delivery after
  cancellation settlement, deliberate new-window attempts, distinct sources with
  identical task text, invalid windows, rejected actions later becoming eligible,
  ordinary repeated tasks, and old receipts surviving allocator exhaustion.
- Agent review: reservation and receipt insertion are synchronous with no
  callback/await boundary. Receipt lookup precedes allocation, survives settlement,
  and targets a retained run. Added a lifetime-invariant comment at the non-null
  lookup; no behavioral fix was required. The tests exercise catalog delivery,
  not yet native buffered input or actual model execution.

## Group 1 API and scope review

| API                                | Contract                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `parseRerunCommand(line)`          | Returns `rerun` with source ID, `invalid`, or `message`; performs no execution.                                      |
| `createChatRunCatalog()`           | Starts a private in-memory catalog at run 1 with no I/O.                                                             |
| `reserveTask(task)`                | Preserves full task text, reserves the next ID, and never deduplicates ordinary tasks.                               |
| `reserveRerun(sourceId, windowId)` | Requires a known settled source and safe arrival identity; returns accepted, duplicate, or a fixed rejection reason. |
| `settle(id, outcome)`              | Accepts only a valid runtime terminal status/reason pair, strips extra fields, and preserves the first settlement.   |
| `get(id)`                          | Returns a detached frozen snapshot or null, without changing catalog state.                                          |

Source task/linkage and settlement snapshots remain private execution data;
no display record, model tool schema, consent, signal, transcript, or provider
payload is stored in this catalog. At group 1 completion, the modules were not
imported by CLI, input, runtime, or observation composition. Existing CLI run
allocation and input handling remained as implemented before that leaf.

Group 1 verification covers the pure parts of source selection, exact task reuse,
action identity, direct linkage, and immutability. Current-conversation submission,
native arrival-window generation, changed-file reads, new patch consent, and
retained display provenance remained unimplemented at that stage.

## Group 1 scoped completion checks

On 2026-10-03:

- Focused parser/catalog suite: **14 passed, 0 failed**.
- `npm run build`: passed strict TypeScript checking and CLI bundling.
- `npm run format:check`: passed after scoped formatting of new files.
- `npm run spec:check`: **7 items passed, 0 failed**. Existing informational
  long-requirement notices do not change their current behavior or scope.
- `git diff --check`: passed for tracked edits; additional whitespace checks
  covered untracked new code/artifacts. **41 local links** were checked.
- Composition-import review found no premature imports of either new module
  from existing CLI/runtime/input/observation files. API/evidence review matches
  the checked source and explicitly leaves actual CLI rerun disabled.

Tasks 1.1–1.4 are implemented, scoped-checked, and agent-reviewed. Human result
acceptance has not been inferred from these checks. No full repository runtime
test run or end-to-end rerun verification is claimed. At group 1 completion,
group 2 was the next candidate pending confirmation. Main behavioral specs
have not been synchronized and the change has not been archived.

## Group 2 input contract and scope review

Tasks 2.1–2.3 are committed as `1c21e2f`, `2315da3`, and `d6ac65f`. Group 2
adds arrival identity and carries it through sequential input; the trusted CLI
does not yet consume it for rerun selection or execution.

| API                                              | Implemented contract                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ChatSubmission`                                 | Readonly `{ line: string, windowId: number }`; native submissions are frozen at arrival.                                                                     |
| `LineInput.readChatSubmission(prompt, options?)` | Additive optional chat read returning an envelope or null; the native reader opens a monotonically increasing safe-integer window before writing the prompt. |
| `LineInput.readLine(prompt, options?)`           | Existing string-or-null read for approval and general consumers; opens no chat window.                                                                       |
| `runChatInput({ onMessage, ... })`               | Prefers envelope reads, passes `(line, windowId)` unchanged, and awaits each callback before the next chat read.                                             |
| Legacy reader without `readChatSubmission`       | Continues string reads with `windowId: undefined`; no arrival identity is synthesized at dequeue.                                                            |

Both read paths share one pending owner and ordered envelope buffer. An overlapping
read rejects without stealing the owner or advancing the window. Startup lines
use window 0. Each later successful chat-read setup opens a new window, including
when it subsequently dequeues a buffered line. That buffered line keeps its
original window. Input arriving during model/tool work keeps the last chat window;
approval reads do not advance it. Prompt output that synchronously causes input
also sees the already-opened window, and new arrivals cannot overtake older ones.

The native tests demonstrate two startup lines retaining window 0 despite two
later prompts, followed by a fresh line in window 3. A held `onMessage` callback
keeps the prompt count at 1 while another line buffers in window 1; after release,
that buffered line still reports 1 and fresh prompt input reports 3. These are
reader identities, not counts of executed tasks.

Whitespace-only lines are ignored; accepted task whitespace is unchanged. Only
exact `/exit` exits. EOF drains ordered envelopes, including readline's final
partial-line emission, before returning null. Closing input explicitly drops the
buffer and settles a pending owner with null. Input failure drops the buffer,
rejects the owner, releases listeners, and remains an error until explicit close.
Cancellation discards buffered envelopes and native partial text, including both
sides of a moved TTY cursor; late input is discarded until the next read. Disposed
abort listeners cannot let an old chat/approval signal cancel a later owner.
Late affirmative resolution is rechecked against cancellation by the approver.

### Rerun policy reserved for later CLI integration

The intended action key remains `(windowId, sourceId)`. Equivalent `/rerun N`
lines received in one window must share one catalog receipt even if dequeued
after settlement; a line received at a fresh post-settlement prompt has a new
window and permits another deliberate attempt. Ordinary tasks are never
deduplicated. Catalog receipts survive settlement; cancellation of input must
not restore an accepted receipt. Reader tests establish arrival metadata, while
group 1 catalog tests separately establish receipt lifetime.

When group 4 routes `/rerun`, a legacy reader without arrival identity must reject
rerun locally with a safe input-capability diagnostic, consume no run number,
and make no model request or transcript change. Ordinary tasks and inspection
remain available. This rejection is a required integration policy, **not current
CLI behavior**: `/rerun` execution and routing are not yet enabled, and the CLI
currently ignores the additive callback argument. Group 4 will test the combined
reader/catalog path, actual duplicate suppression, and command-like approval
input denying without queued replay. Group 2's approval tests already preserve
fresh per-proposal consent and non-TTY denial without consuming chat input.

This follows pi's session-owned submission and abort-and-wait separation in
`../pi/packages/coding-agent/src/core/agent-session.ts`. Arrival windows are yo's
smaller sequential input contract; pi's steering/follow-up queues, persisted
branches, and automatic retry machinery are not introduced.

## Group 2 scoped completion checks and native evidence review

On 2026-10-03:

- `node --test src/line-input.test.ts src/terminal-approval.test.ts src/cli-cancellation.test.ts`:
  **52 passed, 0 failed** (32 input, 9 approval, 11 CLI cancellation tests).
- `npm run build`: passed strict TypeScript checking and CLI bundling.
- `npm run format:check`: passed for the repository after scoped documentation
  formatting.
- `npm run spec:check`: **7 items passed, 0 failed**; structural validation does
  not prove rerun implementation or human acceptance.
- `git diff --check`: passed. **43 local documentation links** were checked.
- Native-reader review matched envelopes to `onLine` arrival, checked window
  creation before synchronous prompt callbacks, FIFO delivery across later reads,
  startup/active/fresh/EOF cases, and one shared chat/approval owner. Cleanup tests
  cover both interactive and noninteractive streams, pending and ownerless input
  failure/close, discarded buffers/partial text, and old abort-listener disposal.
- Approval/CLI regression review confirmed cancelled late consent cannot approve
  the old proposal, no next prompt appears before held cleanup settles, idle
  Ctrl+C exits, completion survives later interruption, and active interruption
  still works after readline EOF. CLI native-reader wrappers were updated in
  task 2.3 to observe the additive read path. No further code fix was needed.

These tests use Node readline over controlled streams, including interactive
editing/interrupt simulation. They are not a new PTY or physical-keyboard run,
live-provider verification, or a full repository runtime test run. Tasks 2.1–2.4
are implemented, scoped-checked, and agent-reviewed; group 3 is the next authorized
implementation group. Human completed-result acceptance is still pending; main
specs are unchanged and this change remains active.

## Task 3.2: safe observation provenance

On 2026-10-03, `RunRecord.rerun` gained a detached frozen copy of only the
positive safe-integer `sourceId` and literal `current_conversation` policy.
`begin(id, task, rerun?)` accepts this display metadata; ordinary records use
null. Record roots and session timing copies are shallow-frozen so display
consumers cannot replace the link, and injected projections retain the original
provenance. Review caught and fixed root-field replacement after the initial
nested-object freeze. This preserves pi's separation of session control and
presentation within yo's smaller in-memory scope.

- `node --test src/run-observation.test.ts src/observation-session.test.ts src/chat-runs.test.ts`:
  **41 passed, 0 failed**.
- Adding `src/terminal-observation.test.ts`: **51 passed, 0 failed**.
- `npm run build`, `npm run format:check`, and `git diff --check`: passed.
- Tests cover caller mutation and extra raw task/action fields, direct chains,
  all terminal settlements and CLI failure, late callbacks, retained applied
  patch/cancelled source evidence, consumer replacement attempts, and clock or
  projection failure without changing catalog eligibility or receipts.

Task 3.2 is scoped-checked and agent-reviewed. Source/policy formatting (3.3),
group 3 consolidated review (3.4), and CLI rerun execution (group 4) remain
pending; these checks do not record human acceptance.

## Task 3.3: rerun presentation

On 2026-10-03, the terminal observation formatter gained shared source/policy
labels for rerun live headers, result cards, list rows, and retained inspection:
`Rerun of #N` and `Context: current conversation`. Ordinary records render
exactly as before. The formatter reads only retained safe display data and adds
no command routing, execution lookup, clock sampling, or input ownership. This
keeps pi's session/presentation separation within yo's textual output scope.

- `node --test src/terminal-observation.test.ts`: **13 passed, 0 failed**.
- `node --test src/terminal-observation.test.ts src/run-observation.test.ts src/observation-session.test.ts src/cli-observation.test.ts src/terminal-renderer.test.ts`:
  **94 passed, 0 failed**.
- `npm run build`, `npm run format:check`, and `git diff --check`: passed after
  formatting the two changed source files.
- Review checked the ordinary exact-output assertions, fixed policy wording,
  direct source links in rerun chains, unchanged source inspection, late-event
  timing freeze, 160-character Unicode previews, sensitive-marker redaction,
  unavailable timing, and durable non-TTY labels with no cursor controls.
- The live-answer test uses the existing answer renderer: the answer is delivered
  once, absent from the automatic result/list, and shown once when retained
  inspection is explicitly requested. Existing observation regression tests
  continue to cover ordered call association and safe patch/error evidence.

Task 3.3 is scoped-checked and agent-reviewed. Group 3 consolidation (3.4) and
CLI rerun routing/execution (group 4) remain pending. These formatter tests do
not claim an enabled CLI command, new PTY/physical-keyboard evidence, live
provider verification, full-suite verification, or human result acceptance.

## Group 3 allocator migration and display authority review

Tasks 3.1–3.3 are committed as `993596f`, `99b4981`, and `25b0f6b`. Task 3.4
consolidates their contracts; the individual 3.2/3.3 checks above remain historical
stage evidence rather than current pending-task status.

`src/cli-app.ts` now creates one trusted catalog per chat. Ordinary input reserves
its exact task and increasing ID before controller creation or observation;
inspection, invalid inspection, whitespace, EOF, and exact `/exit` reserve none.
Repeated ordinary tasks remain distinct. Observation has no allocator:
`begin(id, task, rerun?)` uses the supplied identity, including nonconsecutive
IDs exercised in its tests.

The deferred controller is installed as `active` before observation clocks,
diagnostics, or header callbacks. Observation saves the record and binds its
observer before runtime invocation, so synchronous `run_started` and
`model_requested` events belong to the reserved run. Feed rows preserve run,
step, and call association; terminal output uses local call numbers. Returned
runtime settlement updates conversation and catalog before display settlement,
answer fallback, and result output. Unexpected invocation exceptions retain the
safe `ChatTurnError` exit and display-only `cli_turn_error`; they do not invent
catalog settlement or retry. Old callbacks cannot update settled or later runs.

Full tasks, source eligibility, and numeric action receipts remain catalog-owned.
The 3.2/3.3 display contract passes only safe previews and detached frozen direct
source/policy provenance; display never selects a task or grants execution,
budget, permission, or consent authority. Record roots are shallow-frozen to
protect provenance replacement, not recursively frozen display structures.
Clock/projection failures preserve catalog eligibility and receipts in composed
unit tests; CLI display/diagnostic failures preserve ordinary execution and
transcript. Combined CLI rerun acceptance under failure remains group 4 work.

Review confirmed the reservation/controller/observation/event/settlement order
and absence of catalog lookup or reservation in observation and formatting.
The earlier 3.2 review fix froze record roots after initially freezing only the
nested provenance; no additional code fix was needed. This follows pi's trusted
`AgentSession.prompt` and abort-and-wait ownership in
`../pi/packages/coding-agent/src/core/agent-session.ts`, within yo's sequential
in-memory scope. Pi's branches, queues, persistence, and automatic retry remain
deferred. This task corrects stale maps/proposal stage descriptions.

On 2026-10-03:

- `node --test src/cli-observation.test.ts src/cli-cancellation.test.ts src/observation-session.test.ts src/run-observation.test.ts src/terminal-observation.test.ts src/terminal-renderer.test.ts src/chat-runs.test.ts`:
  **120 passed, 0 failed**, including nested CLI cancellation and approval cases.
- `npm run build`: passed strict TypeScript checking and CLI bundling.
- `npm run format:check`: passed after scoped documentation formatting.
- `npm run spec:check`: **7 items passed, 0 failed**; structural validation does
  not prove runtime conformance or human acceptance.
- `git diff --check`: passed. **64 local links** in affected maps, change artifacts,
  current chat/observation specs, and the development guide were checked.
- Agent review covered ordinary numbering, inspection consuming no numbers,
  synchronous/reentrant callback association, repeated-call ordering, direct
  source chains, late callbacks, source evidence, and provenance replacement.

Tasks 3.1–3.4 are implemented, scoped-checked, and agent-reviewed. CLI `/rerun`
is still not routed and continues ordinary input handling at this stage; group 4
is next. These controlled-stream, faux-runtime, and projection tests are not
integrated CLI rerun, PTY, physical-keyboard, live-provider, or full-suite evidence.
Main specs remain unchanged. Completed-result acceptance and validation-draft
approval have not been inferred; synchronization/archive remain pending.

## Group 4 CLI execution, usage, and review

On 2026-10-03, tasks 4.1–4.6 were implemented and reviewed in separate steps:
`aadcc60`, `234410b`, `d9be023`, `e954a20`, `05f741d`, and `4cbe9f0`.
The common execution path was added in 4.1; tasks 4.2–4.5 needed only tests.
Task 4.6 adds the optional typed `CliDependencies.observationProjectEvent` seam
using the existing projector boundary. Its default and CLI configuration are
unchanged; it introduces no tool, permission, dependency, or execution authority.
Task 4.7 adds `/rerun N` to the existing `OBSERVATION_USAGE` hint, updates the
existing result/CLI assertions, documents [usage](../../../../CONTRIBUTING.md#chat-commands-and-rerun),
and updates project maps/proposal to make task 5.1 the next candidate.
Inspection parsing and its invalid-command diagnostic remain unchanged.

This follows pi's session-owned prompt, terminal-action separation, exact-edit
preparation, and abort-and-wait boundaries within yo's smaller single sequential
conversation and explicit complete-diff consent.

### Exercised behavior

| Scope                                                                                          | Evidence and checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing — `src/cli-rerun.test.ts`                                                              | Malformed, unknown, unsettled, duplicate, and legacy-reader selections remain local. No execution fallthrough, number consumption, or transcript changes; diagnostic failures stay isolated. Lookalikes remain exact ordinary text. Full source tasks remain independent of bounded/redacted previews.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Execution — `src/cli-rerun-execution.test.ts`                                                  | Actual conversation/agent loop, faux provider, real `list_files`, and temporary workspace. A long Unicode/whitespace task follows an intervening correction. Whole-message comparisons prove current conversation exactly once plus the exact task and only the new suffix; command/action metadata never enters model text. Genuine completed, transport-failed, budget-exhausted, and cancelled sources all rerun, and chains link directly to the selected source. Distinct fresh signals preserve the selected model and ten-request/5,000 ms bounds. A rerun after ten exhausted source requests completes on its own tenth request; a call-through timer spy observes ten source and nine rerun tool timers, not elapsed timeout races.                                                       |
| Workspace and consent — `src/cli-rerun-workspace.test.ts`                                      | A new read after an external edit returns present bytes while historical results remain once in context. Applied source edits remain applied before an external addition. Distinct new proposals use current base/next hashes and display their exact complete diffs before approval reads. Fresh `yes` applies only new edits; fresh `N` preserves all current bytes. Call associations and preparation/review/resolution/application are separate; old proposals/approval responses never enter model messages. Non-TTY source and rerun proposals deny without an approval read and leave subsequent chat input intact. Fixtures leave no temporary patch files.                                                                                                                                 |
| Cancellation and source evidence — `src/cli-rerun-cancellation.test.ts`                        | Promise gates hold transport cleanup and outer settlement without sleeps. Cancelled source review produces one aborted patch result/decision. A rerun creates a new proposal/diff; late old `yes` cannot apply it, and only fresh `yes` succeeds. A cancelled rerun stays active until cleanup, with no early prompt/card/request; repeated interrupts are idempotent, late answers are discarded, and no retry is scheduled. Already committed completion wins cancellation races and prints once after outer settlement. A source containing both applied-patch and cancelled evidence remains unchanged; later reads see its applied bytes. Source and rerun inspections are byte-for-byte equal before/after with fixed clocks, and retained messages/events/results/conversation remain equal. |
| Native input — `src/cli-rerun-native-input.test.ts`                                            | Real Node streams and `createNodeLineInput` exercise interactive and noninteractive readers. Equivalent lines arriving before/during held work retain window 2 after dequeue/settlement and report attempt 2 without new requests. Fresh prompt 9 creates attempt 5 with window 9. Mixed repeated ordinary tasks, inspection, and exact exit remain ordered; trailing tasks after exit do not execute. Startup EOF drains window 0, including a final partial duplicate, with four turns and one two-request stream each. At interactive approval `/rerun 1` denies the displayed patch without queued replay; non-TTY opens no approval read and handles the buffered duplicate locally. Current bytes, full preview, and single denied result/decision are checked.                               |
| Display failure isolation — `src/cli-rerun-observation.test.ts`                                | Six cases reach rendering, synchronous streaming observer, settlement answer fallback, projection, clock, and diagnostic failures during acceptance/work/settlement. Fixed safe diagnostics and unavailable timing are checked. Requests, full returned results, and final session equal matching failure-free controls; streaming uses a streaming control. Five turns and ten requests, duplicate windows 7/9, a deliberate new window, and direct source-3 selection prove persistent receipts and runtime-owned eligibility. Late source/rerun callbacks cause no clock sample, output, or diagnostic; frozen inspections and rerun answer/linkage stay unchanged.                                                                                                                              |
| Help and guide — existing `src/terminal-observation.test.ts` and `src/cli-observation.test.ts` | The exact result-card hint now includes `/rerun N`; empty list, unavailable inspection, and completed result expose it without additional requests or numbers. The guide matches exercised grammar, eligibility, exact-task/current-context submission, historical observations versus new current-byte reads, direct linkage, fresh budgets/signals/full-diff consent, one-window receipts versus fresh-prompt repeats, shared approval ownership, legacy rejection, and non-TTY denial.                                                                                                                                                                                                                                                                                                           |

### Checks and review

Earlier leaf checks remain recorded here without repeating overlapping command
blocks. All passed with zero failures, plus each leaf's build, format, and diff
checks. Tasks 4.2 and 4.6 also ran strict specification validation successfully.

| Leaf | Focused command                                  | Focused tests | Related regression tests |
| ---- | ------------------------------------------------ | ------------- | ------------------------ |
| 4.2  | `node --test src/cli-rerun-execution.test.ts`    | 7             | 97                       |
| 4.3  | `node --test src/cli-rerun-workspace.test.ts`    | 5             | 108                      |
| 4.4  | `node --test src/cli-rerun-cancellation.test.ts` | 6             | 119                      |
| 4.5  | `node --test src/cli-rerun-native-input.test.ts` | 9             | 110                      |
| 4.6  | `node --test src/cli-rerun-observation.test.ts`  | 7             | 116                      |

Task 4.7's consolidated related check:

```bash
node --test src/cli-app.test.ts src/cli-rerun.test.ts src/cli-rerun-execution.test.ts src/cli-rerun-workspace.test.ts src/cli-rerun-cancellation.test.ts src/cli-rerun-native-input.test.ts src/cli-rerun-observation.test.ts src/cli-observation.test.ts src/cli-cancellation.test.ts src/terminal-observation.test.ts src/terminal-renderer.test.ts src/observation-session.test.ts src/run-observation.test.ts src/observation-command.test.ts src/rerun-command.test.ts src/chat-runs.test.ts src/line-input.test.ts src/terminal-approval.test.ts src/runtime/conversation.test.ts
```

- **279 passed, 0 failed**, including nested cases. This is a focused combined
  suite, not the final `npm test` check in task 5.3.
- `npm run build`: passed strict TypeScript checking and CLI bundling.
- `npm run format:check`: passed after scoped formatting.
- `npm run spec:check`: **7 items passed, 0 failed**; existing informational
  long-requirement notices do not establish runtime conformance or acceptance.
- `git diff --check`: passed. **65 local links**, including five fragment links,
  in the affected maps, guide, and all active rerun artifacts were checked.

Self-review and earlier parent reviews covered request/suffix accounting, exact
source/current context, real terminal outcomes, fresh signals/budgets, full diff
before separate consent, actual arrival rather than dequeue identity, receipt
lifetime, shared reader ownership, source immutability, reached fault phases,
unchanged projector default, late-consumer guards, and fixture/listener cleanup.
Earlier test-only fixes corrected syntax/types and multiline matching in 4.2,
the patch trail label from `approval_requested` to `waiting` in 4.4, result-card
output accounting in 4.5, and a streaming/nonstreaming control mismatch in 4.6.
No execution defect was found. Task 4.7 review reconciled stale project-state
claims and consolidated duplicate per-leaf evidence; no runtime change beyond
the command hint was needed. Parent review checked the help/runtime diff and
consolidated evidence, including retained counts, coverage, and leaf commits,
and found no issues.

Tasks 4.1–4.7 are scoped-checked and agent-reviewed; commits remain the parent's
responsibility. Apply instructions confirm **19/25** tasks complete, with task
5.1 next. Controlled identities in execution/workspace/cancellation/fault suites
claim no native input evidence; only the native-stream suite supplies that evidence.
None of these checks is a real PTY, physical-keyboard, live-provider, integrated
rerun demonstration, or final full-suite check. Groups 5–6 remain pending.
Current specs and the validation draft remain unchanged, and these checks do not
record human completed-result acceptance or authorize spec synchronization/archive.

## Task 5.1: repeatable integrated rerun demonstration

On 2026-10-03, `examples/run-rerun-demo.ts` adds a temporary `answer.ts` fixture,
the actual CLI/conversation/agent loop, real read/patch tools, a faux transport,
and native `createNodeLineInput` over controlled interactive streams. The
[captured transcript](../../../../examples/run-rerun-demo.txt) is emitted by a
successful run ending in the executable `[VERIFIED: ...]` assertion marker.
The guide documents both modes. No runtime code, dependency, provider
configuration, OAuth credential access, or network request was added.
Scripted input echoes are quoted string literals so original whitespace is
visible without introducing trailing whitespace into the captured file.

### Scenario and executable evidence

1. Run 1 accepts the task with its original surrounding spaces, reads 42, and
   prepares the complete 42 → 43 diff. Ctrl+C at its approval prompt settles
   cancellation with one aborted review/result. `/run 1` inspects it locally.
2. Run 2 adds a corrective conversation turn. Trusted demonstration fixture
   code changes the temporary file to 44 and adds a Unicode marker; this edit
   is not a model-visible write capability. The old file is checked before edit.
3. `/rerun 1` creates linked run 3 and reads the current 44 plus marker. One
   equivalent tab-separated line arrives beside the command, and another
   space-separated variant arrives while the model response is held. After
   settlement both report existing run 3. Captured submission identities are
   `[4, 4, 4, 9, 11]`, proving buffered window 4 versus deliberate fresh prompts.
4. Fresh prompt 9 creates run 4. Its newly prepared complete 44 → 45 diff
   receives `/rerun 1` at approval: the response denies this patch and never
   becomes a chat command. Current bytes are checked before each review.
5. Fresh prompt 11 creates run 5 and displays another new complete 44 → 45
   diff. Only new `yes` applies it, retaining the corrective marker. `/runs`,
   `/run 1`, and `/run 5` inspect retained evidence before exact `/exit`.

Assertions check all five exact tasks and terminal outcomes; per-attempt request
counts `[2, 1, 2, 3, 3]`; the entire current conversation exactly once followed
by one exact task; and suffix-only transcript append. Command/action metadata is
absent from all model messages. Five distinct signals and the ten-request/
5,000 ms budgets are checked. Real structured read results retain historical 42
and present 44/marker respectively. All three complete preview strings are
compared exactly; review decisions are aborted/denied/approved and exactly one
application occurs. Final file bytes equal 45 plus marker. Four `/run 1`
inspections are byte-for-byte identical, including frozen timing and cancelled
patch evidence. Result cards for runs 3–5 and inspection of run 3 retain the
direct source and current-conversation labels. No error diagnostic is emitted,
and owned keypress/error listeners return to their pre-reader counts.

`--tty` uses the same fixture, faux stages, and final assertions, with printed
`SOURCE_REVIEW`, `RERUN_READ_WAIT`, `FRESH_REVIEW_DENY`, and
`FRESH_REVIEW_APPROVE` markers. A passive demonstration-only stdin `data` observer
releases run 3's gate on Return, leaves the input in the native reader buffer,
and removes its own data/end/abort listeners in `finally`. There is no second
read owner, input consumption, timer-based deduplication, or harness change.
This mode is prepared for task 5.2 and was **not** run through a PTY in 5.1.

### Checks and review

```bash
node examples/run-rerun-demo.ts > examples/run-rerun-demo.txt
node examples/run-rerun-demo.ts > /private/tmp/yo-rerun-demo-repeat.txt
cmp examples/run-rerun-demo.txt /private/tmp/yo-rerun-demo-repeat.txt
node --test src/cli-rerun-native-input.test.ts src/cli-rerun-workspace.test.ts src/cli-rerun-cancellation.test.ts src/line-input.test.ts src/terminal-approval.test.ts
./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --allowImportingTsExtensions --verbatimModuleSyntax --skipLibCheck --module ESNext --moduleResolution Bundler --target ES2024 --types node examples/run-rerun-demo.ts
npm run build
npm run format:check
npm run spec:check
git diff --check
```

- The demo ran successfully twice; captured outputs compared byte-for-byte.
- **61 focused tests passed, 0 failed**, including nested native/consent cases.
- Build, explicit strict example type checking, formatting, and diff checks
  passed. Examples are outside the repository tsconfig, so their separate type
  check uses TypeScript 7's required `--ignoreConfig` flag.
- Strict OpenSpec validation passed **7 items, 0 failed**. Informational long
  requirement notices remain; structural validation does not prove conformance.
- Self-review covered actual submission ingress, source/current transcript
  equality, held active-work input, duplicate dequeue after settlement, fresh
  prompts, approval ownership, complete previews, current bytes, source evidence,
  listener cleanup, and removal of the temporary fixture. One initial cleanup
  assertion incorrectly expected Node's internal `emitKeypressEvents` data helper
  to disappear with readline; it was corrected to test owned keypress/error
  listeners. Explicit diff checking of the new untracked transcript also caught
  intentional trailing spaces in input echoes; quoting those echoes preserves
  native input bytes while keeping the captured file clean. Parent review of
  demo assertions, the passive gate, and the transcript found no further issue.
  All 19 local link paths in the affected guide/evidence files exist. No runtime
  defect or expanded capability was found.

Task 5.1 is scoped-checked and agent-reviewed; task 5.2 is next. This evidence is
controlled-stream integrated demonstration, not real PTY, physical-keyboard,
live-provider, or final full-suite verification. No completed-result acceptance,
spec synchronization, archive, or validation-draft approval is inferred.

## Task 5.2: integrated scenario through a real local PTY

On 2026-10-03, [the Python driver](../../../../examples/verify-rerun-pty.py)
executed `node examples/run-rerun-demo.ts --tty` through `pty.fork()` on the
local macOS host. It uses only Python's standard library and the existing demo;
no runtime code or dependency changed. The master descriptor is a real terminal,
and `tcgetpgrp(master) == child_pid` confirms the child owns its foreground
process group. The demo itself rejects `--tty` unless both native stdin and
stdout are TTYs. This exercises real Node readline and the trusted CLI controller,
following pi's session-owned input and abort-and-wait boundary in yo's smaller
sequential scope.

### Reproduction and terminal sequence

From the repository root:

```bash
python3 examples/verify-rerun-pty.py /private/tmp/yo-rerun-pty.log
python3 examples/verify-rerun-pty.py /private/tmp/yo-rerun-pty-repeat.log
```

Both completed with exit code **0**. The driver saves the raw PTY bytes to the
specified local log; omitting the argument uses the system temporary directory.
It waits for terminal markers and prompts rather than sleeping to time input.
Each expectation has a 15-second failure bound. ANSI control removal and CR
normalization are used only for matching output, never for input identity.

1. At the first real `yo>` prompt, submit the exact task with its surrounding
   spaces. At `SOURCE_REVIEW`, send terminal byte `0x03`, not `kill(SIGINT)` or
   an injected interrupt callback. Wait for `Run #1 result: cancelled`, the
   `aborted` stop reason, and the next prompt. The complete 42 → 43 diff was
   shown; approval and the patch result settle aborted without application.
2. Inspect `/run 1`, await its next prompt, and submit the corrective turn.
   Run 2 performs the existing trusted fixture edit to 44 with the marker.
3. At prompt 4, send `/rerun 1` and the equivalent `" /rerun\t1 "` in one
   terminal write. At the active `RERUN_READ_WAIT` marker, send ` /rerun  1`.
   Return releases the demo's passive gate while native readline retains the
   line. Run 3 settles, then **two** duplicate diagnostics identify existing
   Run #3 without a new request or number.
4. After those diagnostics and a fresh prompt, inspect runs 1 and 3. Submit
   a fresh `/rerun 1`, which creates Run 4. At `FRESH_REVIEW_DENY`, enter
   `/rerun 1` as the approval response. It denies the new complete 44 → 45
   proposal and is consumed by approval; no queued rerun follows settlement.
5. Inspect run 1 again, then submit a deliberate fresh `/rerun 1` for Run 5.
   At `FRESH_REVIEW_APPROVE`, only the new `yes` applies its separately prepared
   complete 44 → 45 diff. Inspect `/runs`, `/run 1`, and `/run 5`, then `/exit`.

### Assertions and observed output

The driver checks two duplicate diagnostics, exactly three complete patch
previews (42 → 43 once, 44 → 45 twice), denial/application answers, absence of
Run #6, the demo's final executable assertion marker, and normal child exit.
Because it exits through the demo, all existing integrated assertions run on
the actual PTY input: arrival windows **`[4, 4, 4, 9, 11]`**, exact tasks/current
conversation and suffix accounting, request counts **`[2, 1, 2, 3, 3]`**, five
distinct signals/fresh budgets, current-file reads, aborted/denied/approved
decisions, one application, final bytes 45 plus marker, four identical source
inspections, direct source labels, and owned listener/fixture cleanup.

The driver printed:

```text
PTY: Ctrl+C byte cancelled source review; fresh chat prompt recovered.
PTY: normalized batch and active-work duplicates drained as two Run #3 receipts.
PTY: fresh prompts allocated Runs #4/#5; command-like denial stayed approval input; new yes applied.
PTY PASS: child exit 0; demo assertions passed; three complete diffs; two duplicates; no Run #6.
Raw PTY output: /private/tmp/yo-rerun-pty.log
```

The raw terminal output contains the cancelled source result, linked completed
results for runs 3–5, both `Rerun action already accepted as Run #3.` diagnostics,
the three full diffs before their approval prompts, and:

```text
[VERIFIED: exact source task/current transcript; changed-file reads; five fresh attempts; two suppressed duplicates; denial owns command input; new full-diff yes; immutable source inspections]
```

### Checks, review, and limits

Self-review checked sequential marker matching, actual terminal/foreground
ownership, the Ctrl+C byte path, batch versus active input, prompt boundaries,
the child exit/assertion gate, raw-output retention, and failure cleanup of the
child/PTY. An initial driver expectation combined cancellation and stop reason
on one line; it was corrected to match their existing separate output lines.
No demo or runtime defect was found. Parent review checked the driver sequence,
Ctrl+C byte, markers, and assertions and found no issues.

Scoped regression/check commands:

```bash
node --test src/cli-rerun-native-input.test.ts src/cli-rerun-workspace.test.ts src/cli-rerun-cancellation.test.ts src/line-input.test.ts src/terminal-approval.test.ts
npm run build
npm run format:check
npm run spec:check
git diff --check
git diff --no-index --check /dev/null examples/verify-rerun-pty.py
```

- **61 focused tests passed, 0 failed**, including nested cases.
- Build, Python syntax compilation without generating cache files, formatting,
  tracked/untracked diff checks, and the new relative link check passed.
- Strict OpenSpec validation passed **7 items, 0 failed**; its informational
  notices do not prove runtime conformance or human acceptance.
- The untracked-file `--no-index --check` produced no whitespace diagnostics;
  its exit code 1 denotes the new file's difference from `/dev/null`.

This is **real local PTY evidence with a faux provider**. It does not claim
physical-keyboard operation, terminal-emulator UX coverage, process-signal
cancellation coverage, live model/OAuth/network behavior, every source outcome
in a PTY, or final full-suite verification. The deterministic gate and clock
do not prove arbitrary timing races or held-cleanup behavior; focused tests
record those separate boundaries. Full repository checks and requirement review
remain task 5.3. Completed-result acceptance, spec synchronization/archive, and
the validation draft remain separate and unapproved by this verification.

## Task 5.3: final regression and requirement review

On 2026-10-03 the final review covered the implemented CLI control, native input,
catalog, observation provenance, actual conversation/loop, cancellation, and
current-byte patch consent. This reuses pi's session-owned submission,
presentation separation, and abort-and-wait pattern within yo's sequential,
in-memory scope. No runtime capability, dependency, tool, or permission changed
in this task.

### Findings and regression demonstrations

The first full suite passed **568 tests**, build, formatting, strict specification
validation, and diff checks. Additional runs of all three existing demonstrations
used Python `subprocess.run(..., capture_output=True, timeout=20)` so an input
regression could not hang verification indefinitely.

- Observation demo exited **0**; its captured output was stale only because the
  six command hints lacked the already implemented `/rerun N` usage.
- Cancellation demo initially exited **13** with Node's unsettled top-level await
  warning at `modelWaiting`. Its controlled-stream wrapper instrumented only
  `readLine`; `runChatInput` now prefers native `readChatSubmission`, so scripted
  chat input and prompt gates were bypassed. The wrapper now instruments that
  additive path for chat while `readLine` retains exclusive patch approval
  instrumentation. Both delegate to the same native reader. The `--tty` branch
  still uses the native reader directly and is unchanged.
- After the fix, cancellation demo exited **0** with its existing assertions:
  held model/outer cleanup, repeated Ctrl+C, partial/late affirmative discard,
  fresh consent applying 42 → 43, no late answer, and identical frozen source
  inspections. Its captured output also changed only in six usage hints.
- Rerun demo exited **0** and matched its existing captured transcript byte for
  byte. Both older transcripts were regenerated from actual output; prompt/input
  bytes were preserved. A second bounded run of all three matched every committed
  transcript exactly.

The examples are outside the build's `src` include. Separate strict checking of
the edited cancellation demo passed with:

```bash
./node_modules/.bin/tsc --ignoreConfig --noEmit --module ESNext --moduleResolution Bundler --target ES2024 --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --allowImportingTsExtensions --verbatimModuleSyntax --skipLibCheck examples/run-cancellation-demo.ts
```

The initial explicit-file TypeScript invocation returned `TS5112` because this
version requires `--ignoreConfig` alongside file arguments in a project. The
corrected command above passed; no type or runtime source fix was required.

### Requirement-to-evidence review

The following rows cover **all 12 requirements and 41 scenarios** in the
[CLI delta](specs/cli-chat/spec.md) and
[observation delta](specs/run-observation/spec.md). Scenario names identify the
reviewed contract; the referenced adjacent test files contain the executable
assertions and are included in the final full suite. Earlier group sections
explain the assertions, faux transport, gates, and bounds in detail.

| Delta requirement                                                   | Scenarios reviewed                                                                                                                                                           | Evidence and conclusion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI: Sequential input ownership                                     | Exit token must be exact; Active patch approval; Cancel approval and continue; Command-like approval input                                                                   | `line-input.test.ts`, `cli-app.test.ts`, `terminal-approval.test.ts`, `cli-cancellation.test.ts`, `cli-rerun-native-input.test.ts`, and `cli-rerun-cancellation.test.ts` prove exact exit/whitespace/EOF rules, one shared owner, settlement before chat reads, late cancelled-input discard, and `/rerun 1` consumed only as denial at approval. The repaired cancellation demo preserves these assertions; rerun demo and task 5.2 PTY exercise command denial and fresh recovery.                               |
| CLI: Fresh budgets and recoverable turn failure                     | Failed turn followed by another task; Rerun after budget exhaustion; Failure without explicit request                                                                        | `cli-app.test.ts` checks ordinary transport/budget recovery; `cli-rerun-execution.test.ts` starts a genuine exhausted source and observes ten fresh rerun requests plus separate 5,000 ms tool timers. `cli-rerun-cancellation.test.ts` holds cleanup and checks no new request/prompt/retry until explicit input. Source review of `runtime/tool-dispatcher.ts` confirms review awaits outside the separate preparation/application timers; existing patch tests exercise their unchanged consent/lifecycle path. |
| CLI: Precisely recognized rerun command                             | Valid command variants; Malformed reserved input; Other tokens remain ordinary                                                                                               | `rerun-command.test.ts` and `cli-rerun.test.ts` cover every listed malformed form, safe-integer bounds, spaces/tabs, lookalikes and exact ordinary whitespace. Invalid reserved input stays local without tasks, transcript additions, numbers, or calls; native/demo/PTY inputs exercise normalized variants.                                                                                                                                                                                                     |
| CLI: Settled current-session rerun source                           | Every returned terminal outcome is eligible; Invalid source is local; Full task survives lossy preview                                                                       | `chat-runs.test.ts` proves independent session catalogs, unknown/unsettled rejection and immutable full tasks; `cli-rerun.test.ts` checks no number consumption and rejection despite display settlement. `cli-rerun-execution.test.ts` uses real returned completed/transport-failed/cancelled/exhausted outcomes. Long Unicode/whitespace and redacted/control-containing tasks execute exactly while safe previews remain bounded. No cross-session lookup exists.                                              |
| CLI: Rerun uses current conversation and workspace                  | Intervening turns are retained; Files change before a rerun; Rerun of a rerun                                                                                                | `cli-rerun-execution.test.ts` compares whole requests and suffixes with intervening correction and direct source-3 selection; commands/action fields are absent. `cli-rerun-workspace.test.ts` forces a new read of externally changed bytes while historical results occur once. Rerun demo asserts the same task/context/read boundaries.                                                                                                                                                                        |
| CLI: One attempt per rerun action                                   | Duplicate delivery during active work; Buffered duplicate after settlement; Deliberate later attempt; Mixed buffered input and EOF; Reader cannot establish arrival identity | `chat-runs.test.ts` proves atomic persistent receipts; `line-input.test.ts` assigns identity at ingress, preserves startup/buffered windows, and shares ownership. `cli-rerun-native-input.test.ts` exercises held work, normalized duplicates, fresh prompts, repeated ordinary tasks, ordered inspection/exit and partial EOF drain in both input modes. `cli-rerun.test.ts` checks legacy rejection without fabricated identity. Demo/PTY assert two suppressed duplicates, fresh windows and five attempts.    |
| CLI: Rerun preserves cancellation and patch boundaries              | Prior approval does not authorize a rerun patch; Cancelled review followed by rerun; Cancellation during new work; Noninteractive rerun                                      | `cli-rerun-workspace.test.ts` verifies applied bytes persist, separately prepared current-base complete diffs, fresh yes/denial and non-TTY denial without a read. `cli-rerun-cancellation.test.ts` rejects late source consent, holds rerun cleanup, compares distinct signals, and retains committed completion in races. Demo/PTY add real tools and approval ownership; no old proposal/signal/consent is replayed.                                                                                            |
| Observation: Session-local sequential runs                          | Consecutive tasks retain distinct records; A new chat starts empty; Inspection does not consume a run number; Accepted rerun is a separate record                            | `chat-runs.test.ts`, `cli-observation.test.ts`, `cli-rerun.test.ts`, and native/demo assertions check one allocator, increasing ordinary/rerun IDs, session reset, separate evidence, and no numbers for inspection/rejection/duplicates. `cli-app.ts` awaits each controller settlement before the next submission.                                                                                                                                                                                               |
| Observation: Inspection commands are local and precisely recognized | Valid command variants; Malformed reserved commands stay local; Other input is preserved                                                                                     | `observation-command.test.ts` and `cli-observation.test.ts` cover existing grammar, every malformed inspection form and ordinary-token preservation. `cli-app.ts` routes inspection independently before rerun; inspection invokes no turn or clock. The observation regression demo preserves this behavior with updated hints.                                                                                                                                                                                   |
| Observation: Safe rerun provenance is visible                       | Linked attempt from start to inspection; Link is direct and stable; Ordinary runs and plain output                                                                           | `run-observation.test.ts` and `observation-session.test.ts` prove creation-before-synchronous-events and detached immutable direct source/policy allowlists with raw fields excluded. `terminal-observation.test.ts` checks header/result/list/inspection labels, unchanged ordinary output, frozen links through chains, and durable non-TTY text. Demo/PTY show all four surfaces.                                                                                                                               |
| Observation: Source evidence remains immutable through rerun        | Source before and after rerun; Source with applied patch and cancelled result; Late callbacks across attempts                                                                | `cli-rerun-cancellation.test.ts` compares full source snapshots and inspections with applied-patch/cancelled evidence retained while the new run shows only new evidence. `cli-rerun-observation.test.ts`, `run-observation.test.ts`, `observation-session.test.ts`, and `terminal-observation.test.ts` check late source/rerun callbacks, distinct association, immutable linkage and no clock resampling. Demo/PTY assert four identical source inspections.                                                     |
| Observation: Rerun display does not control execution               | Lossy task display; Display consumers fail; Inspection remains local                                                                                                         | `cli-rerun.test.ts` proves full exact tasks survive redacted/truncated previews. `cli-rerun-observation.test.ts` reaches rendering/projection/observer/fallback/clock/diagnostic faults and compares requests, results and final session with matching controls; receipt count, source identity and consent remain execution-owned. `cli-observation.test.ts` checks inspection request/transcript/clock invariance; existing observation tests preserve sanitization and bounds.                                  |

Self-review traced parsing → catalog receipt/reservation → fresh controller →
observation creation → current conversation/turn → trusted settlement → frozen
display. No scenario was dropped or narrowed. The catalog stores tasks/outcome
pairs and numeric receipts, while display stores only safe previews and fixed
provenance. Runtime conversation, tool registry, patch application, and provider
contracts are reused. Review found only the demonstration-wrapper regression and
stale help transcripts above; the task needed no runtime correction.

### Final checks and acceptance scope

The full runtime suite and build passed before the demo-only fix; no `src` file
changed. The edited example then passed its separate strict check and bounded
regression run. Formatting/specification/diff checks were refreshed after the
documentation updates:

```bash
npm test
npm run build
npm run format:check
npm run spec:check
git diff --check
```

- **568 tests passed, 0 failed**, including nested cases; 27 suites, no cancelled,
  skipped, or todo tests.
- Strict TypeScript checking and CLI bundling passed. The edited example's
  separate strict check above also passed.
- Formatting and diff checks passed. **72 relative links** and the scenario
  matrix were checked against the actual files and delta headings.
- Strict OpenSpec validation: **7 items passed, 0 failed**. Existing informational
  long-requirement notices are structural advice, not runtime or acceptance proof.
- Observation, cancellation and rerun demonstrations each exited **0** within
  their 20-second bound and matched the regenerated/existing captured output.

The implemented result for human acceptance is explicit `/rerun N` of any
settled current-session attempt, exact task/current conversation, present-byte
reads and newly prepared patch consent, fresh budgets/controller, linked safe
display, one attempt per arrival-window action, deliberate later repeats, and
unchanged source evidence. Inspection and rejected actions stay local. This
includes full-suite and deterministic/native-stream evidence plus the previously
recorded task 5.2 **real local PTY with faux provider** evidence.

The demo fix affects only controlled-stream instrumentation, so task 5.2's
unchanged TTY path was not rerun here. No fresh PTY claim is made by task 5.3.
Physical keyboard, terminal-emulator UX, live OAuth/model/network behavior, and
arbitrary timing races remain outside the recorded coverage; focused held-cleanup
and race tests provide their separate controlled evidence. Rerun does not force
the model to reread every historical file. Original-context snapshots, branching,
persistence, rollback, automatic retries, parallel runs, new tools/providers and
allowlisted validation remain deferred.

At task 5.3 completion, tasks 1.1–5.3 were checked and agent-reviewed, and the
documentation still treated a separate completed-result reply as the next
boundary. Task 6.1 below reconciles that expectation with the received standing
human approval. These checks themselves do not supply human acceptance. Current
specs were unchanged and the change remained active at this checkpoint.

## Task 6.1: standing human approval and accepted scope

The human's actual instruction received on 2026-10-03 was:

> выполняй задачи, считая, что я аппрувнул каждую. каждую задачу выполняй в отдельном субагенте. после каждой задачи создавай коммит.

This is explicit advance approval of every task in the active, bounded
`rerun-settled-runs` change, including recording its accepted scope, synchronizing
verified deltas, and archiving (6.1–6.3). The task 6.1 wording originally assumed
a distinct completed-result acceptance reply. The direct human instruction
supersedes that extra wait. The source of closure authorization is this received
human message; passing checks, agent review, and OpenSpec status do not supply it.
No later acceptance message is invented, and no claim is made that the human
personally reviewed the completed test results.

The scope accepted under that standing approval is the verified result described
in [task 5.3](#task-53-final-regression-and-requirement-review): explicit `/rerun N`
for settled current-session runs, the complete original task and current
conversation, new reads and proposals against present bytes, fresh budgets and
cancellation controller, fresh complete-diff patch consent, direct safe source
linkage, arrival-window duplicate suppression with deliberate fresh-prompt
repeats, immutable source evidence, and local inspection/rejected actions. This
follows pi's trusted session submission and presentation separation within yo's
sequential in-memory scope.

The evidence remains the recorded **568-test** full suite, **12 requirements /
41 scenarios**, deterministic/native-stream demonstrations, and task 5.2's
**real local PTY with a faux provider**. Physical keyboard, terminal-emulator UX,
live OAuth/model/network behavior, arbitrary timing races, and forced rereads of
all historical files are not covered. Original-context snapshots, branching,
persistence, rollback, automatic retries, parallel execution, and broader tools
remain deferred. In particular, the later allowlisted-validation draft is outside
this authorization and remains unapproved.

Task 6.1 changes only approval evidence and current documentation status. Main
spec synchronization and archive remain separate tasks 6.2 and 6.3. Documentation
checks and review are recorded below; no fresh runtime or PTY execution is claimed.

On 2026-10-03, documentation-only checks passed:

- `npm run spec:check`: **7 items passed, 0 failed**; existing informational
  long-requirement notices remain structural advice.
- `npm run format:check` and `git diff --check`: passed.
- **86 local link paths and 15 heading fragments** in maps, the guide, active
  rerun artifacts, and affected current specs resolved. Delta headings still
  contain **12 requirements and 41 scenarios**, matching the retained matrix.
- Agent review checked the exact message, standing approval versus a distinct
  later reply, bounded accepted scope, historical checkpoint preservation,
  coverage limits, and validation's unapproved status. No runtime source, main
  specification, dependency, permission, or validation-draft artifact changed.
- Parent review found no issues in the direct-instruction handling, transparent
  advance approval, absence of fabricated later acceptance/personal review, or
  bounded scope and validation exclusion. Only task 6.1 is marked complete;
  synchronization and archive remain pending.

## Task 6.2: verified specification synchronization

On 2026-10-03, the apply/sync-specs workflow resolved the repository root and
exactly two delta paths from the pinned CLI's status response. One valid
`instructions specs --change rerun-settled-runs --json` snapshot was read before
main-spec writes. Its observable-behavior rule was applied only to the two
verified capabilities, under the standing human approval recorded in task 6.1.

The merge updates two requirements and adds five in
[CLI chat](../../../specs/cli-chat/spec.md); it updates two and adds three in
[run observation](../../../specs/run-observation/spec.md). This records the already
verified exact-task/current-context execution, arrival-window receipts, fresh
budgets/controller/complete-diff consent, immutable source evidence, and safe
display provenance. It follows pi's session-owned submission and presentation
separation without adding any harness capability.

| Current specification | Requirements before → after | Scenarios before → after |
| --------------------- | --------------------------- | ------------------------ |
| CLI chat              | 7 → 12                      | 16 → 37                  |
| Run observation       | 18 → 21                     | 44 → 54                  |
| Combined              | 25 → 33                     | 60 → 91                  |

Agent review and a comparison against Git HEAD confirmed all **12 delta
requirements / 41 delta scenarios** match the resulting main blocks, every
one of the **60 original scenarios** remains verbatim, and all unaffected
requirement blocks retain their text and order. Each main spec has one
`Requirements` section and no delta operation headers. Titles and entire Purpose
sections remain unchanged, as required by sync-specs. Run observation's Purpose
still contains the historical Milestone 4/deferred-cancellation-and-rerun wording;
the synchronized requirements describe current behavior. Updating that
introduction is outside this merge and was not done silently.

Documentation-only checks:

- `npm run openspec -- validate --specs --strict --no-interactive`: **5 passed,
  0 failed**.
- `npm run openspec -- validate rerun-settled-runs --type change --strict --no-interactive`:
  the active rerun change is valid against the synchronized main specs.
- `npm run format:check` and `git diff --check`: passed.
- **88 local link paths and 15 heading fragments** in maps, the guide, active
  rerun artifacts, and affected current specs resolve.
- `npm run spec:check`: **6 passed, 1 failed**. The sole failure is the later,
  unapproved `allowlisted-validation` draft: its CLI-chat MODIFIED block for
  `Fresh budgets and recoverable turn failure` omits the now-current scenarios
  `Rerun after budget exhaustion` and `Failure without explicit request`.
  This is the draft's required rebase/review dependency, not a failed current
  spec or rerun delta. The draft remains untouched and unapproved; no current
  scenario was removed to make the global check pass. Informational
  long-requirement notices remain structural advice.

Only the two current specifications, this evidence, and task 6.2's checkbox are
changed. No runtime, dependency, permission, draft, or project-map change is made,
and no fresh runtime/PTY/live-provider check is claimed. Task 6.3 remains pending;
at that task 6.2 checkpoint the accepted change was still active.

## Task 6.3: archive and project-map closure

On 2026-10-03 the apply/archive workflow resolved the repository root, the
`spec-driven` schema, and both delta paths from the pinned CLI. Apply/list
reported **24/25** tasks complete, with only task 6.3 pending; all planning
artifacts were complete. Archive context and both guidance entries were applied:
retain received human approval, synchronize only reviewed verified behavior,
update project-map links, and preserve deferred work's unapproved status.
The standing approval recorded in task 6.1 covers this archive and its remaining
map/link checks, so it requires no invented additional acceptance message.

Before moving the change, all **12 delta requirement blocks** were compared with
the two current specs and matched exactly. The active change also passed strict
validation against those synchronized specs. No second synchronization was
started. The archive destination did not exist. The pinned command was:

```bash
npm run openspec -- archive rerun-settled-runs --skip-specs --yes
```

It archived the accepted change as
`openspec/changes/archive/2026-10-03-rerun-settled-runs/`. The CLI's **one incomplete
task** warning refers to this closure task itself, whose map/link checks occur
after the move; the explicit standing approval covers completing it. The
nonblocking proposal notice about more than ten deltas remains informational.
`--skip-specs` avoided rewriting already synchronized specifications, and
`--yes` applied the existing approval to the archive confirmation.

`PRD.md`, `IMPLEMENTATION_PLAN.md`, and `CONTRIBUTING.md` now identify rerun as
implemented, verified, synchronized, and archived, and link to its preserved
design, tasks, and evidence. The next planning candidate is the unapproved
validation draft's rebase/review; its first implementation leaf still requires
separate confirmation. Relative archive links to current specs, the guide, and
examples were repaired for the extra directory level. Historical staged
verification and its then-pending scope remain historical. The pi references
continue to describe trusted session submission, presentation separation, and
abort-and-wait ownership; no additional pi behavior or harness capability is
introduced by archival.

Documentation-only checks and agent review:

- `npm run openspec -- validate --specs --strict --no-interactive`: **5 passed,
  0 failed**. No current requirement or scenario was changed in this task.
- `npm run openspec -- list --json`: rerun is absent from active changes; the
  only active change is the unapproved validation draft at **0/22** tasks.
- Archive structure/content checks retain all seven files, including
  `.openspec.yaml`, and confirm the active rerun directory is absent. SHA-256
  comparisons preserve both delta files, archive configuration, all five
  current specifications, and every validation-draft file byte for byte.
  All 12 archived delta blocks still match their current requirements.
- **92 local link paths and 21 heading fragments** resolve.
  `npm run format:check` and `git diff --check` pass, including separate
  `git diff --no-index --check /dev/null <file>` whitespace checks on all seven
  new archive files.
- `npm run spec:check`: **5 passed, 1 failed** after rerun leaves the active list.
  Its sole failure remains the unapproved validation draft's CLI-chat MODIFIED
  block for `Fresh budgets and recoverable turn failure`, which omits current
  scenarios `Rerun after budget exhaustion` and `Failure without explicit request`.
  This is the next draft's rebase/review prerequisite, not a failed
  current requirement or archived rerun delta. The draft is untouched and no
  implemented scenario was removed to make the global check pass.
- Agent self-review checks received standing approval versus a later fabricated
  reply, completed scope and retained coverage limits, archive path/date and
  artifact preservation, current-versus-historical state, repaired links,
  no second sync, and validation's explicit unapproved status. Parent reviewed
  the maps/guide and found their scope and draft-prerequisite claims accurate.

Task 6.3 is checked only after its archive/map/link/format/diff checks and agent
review. The archived tracked task file then contains **25/25** completed tasks.
Active apply instructions cannot report that archived progress; active-list
absence plus the archived checkbox count provide closure evidence. No runtime,
example implementation, dependency, permission, current specification, or future
draft changed, and no fresh runtime, PTY, physical-keyboard, or live-provider
verification is claimed by this documentation-only task. Existing 568-test and
real local PTY/faux-provider evidence remains in tasks 5.2–5.3 with its limits.
