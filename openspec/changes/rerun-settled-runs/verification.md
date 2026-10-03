# Verification: Explicit rerun of settled runs

## Authorization and coverage boundary

On 2026-10-03 the user requested the planning artifacts and selected current
conversation context. After the first implementation candidate was presented,
the user's “ok. continue” authorized **group 1 only**: pure parser, trusted task
catalog, action receipts, focused tests, and this evidence.

The later “выполняй задачи, считая, что я аппрувнул каждую. каждую задачу выполняй
в отдельном субагенте. после каждой задачи создавай коммит” authorizes the remaining
rerun implementation tasks, with one subagent and commit per task. It does not
record human acceptance of a completed rerun result or authorize the later
allowlisted-validation draft. Spec synchronization and archive still follow
completed-result acceptance.

CLI rerun is not yet enabled. Group 1 checks cover pure contracts; group 2 below
adds native-stream input evidence; group 3 covers ordinary CLI identity and safe
linked observation. Actual CLI rerun model requests, changed-file/patch rerun,
PTY, physical-keyboard, and live-provider verification remain outside these
staged checks.

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

## Task 4.2: accepted rerun execution and fresh bounds

On 2026-10-03, `src/cli-rerun-execution.test.ts` verifies the common execution
path introduced by task 4.1 (`aadcc60`). No production-code change was needed:
accepted ordinary and rerun attempts already share trusted controller creation,
observation, `runConversationTurn`, and returned settlement. This follows pi's
session-owned prompt and abort-and-wait separation within yo's single sequential
conversation.

- The faux provider uses the actual conversation/agent loop and closed tool
  dispatcher. `list_files` executes successfully in a temporary workspace;
  source outcomes are generated by real completion, a thrown transport error,
  ten tool-bearing requests, and the CLI's trusted interrupt listener. The tests
  do not fabricate terminal session outcomes.
- A long Unicode task with leading/trailing whitespace and a newline is rerun
  after an intervening correction. Each first request equals the current
  structured conversation plus one exact source task; each returned conversation
  equals its prior messages plus only the new four-message suffix. Distinct call
  IDs occur once. No rerun command or action/provenance metadata enters model
  messages. Rerunning run 3 links run 4 directly to 3, while run 3 links to 1.
- Completed, transport-failed, budget-exhausted, and cancelled sources each
  accept one explicit new attempt. Every invocation starts with a distinct
  non-aborted signal that is passed to its transport, the same selected model,
  and a `run_started` budget of ten requests and 5,000 ms per tool. The cancelled
  source remains aborted while its rerun completes with a fresh signal.
- After a source exhausts all ten requests, its rerun completes on its own tenth
  request with model steps 1–10. A call-through timer spy records nineteen fresh
  5,000 ms execution timers: ten source tool executions and nine rerun tool
  executions. This checks configured timer creation, not elapsed timeout or
  cleanup races, which remain covered by the existing runtime suites.

Checks and self-review:

- `node --test src/cli-rerun-execution.test.ts`: **7 passed, 0 failed**.
- `node --test src/cli-rerun-execution.test.ts src/cli-rerun.test.ts src/cli-cancellation.test.ts src/cli-observation.test.ts src/runtime/conversation.test.ts src/chat-runs.test.ts`:
  **97 passed, 0 failed**, including nested cases.
- `npm run build`, `npm run format:check`, and `git diff --check`: passed.
- `npm run spec:check`: **7 items passed, 0 failed**. Refreshed apply instructions
  confirm task 4.2 checked and progress **14/25**; task 4.3 is next.
- Self-review checked exact whole-message comparisons, genuine terminal outcomes,
  fresh cancellation signals, direct chain labels, step resets, real tool results,
  timer-spy restoration, and temporary-workspace cleanup. Initial test-only
  syntax/type and multiline-matching errors were fixed before the passing checks.

Parent review checked the actual-loop fixture, request structure, and budget timer
coverage and confirmed the test scope. Task 4.2 is scoped-checked and reviewed;
commit remains with the parent. Tasks 4.3–4.7 and groups 5–6 remain pending. These injected-input faux
provider tests claim no native arrival-window semantics, changed-file/patch
consent integration, held cancellation cleanup, PTY/physical-keyboard testing,
live provider, full-suite verification, or human result acceptance. Current
specs and the unapproved validation draft remain unchanged.
