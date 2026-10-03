# Tasks

Planning artifacts were requested on 2026-10-03; current-conversation policy was
explicitly selected. The subsequent “ok. continue” initially confirmed group 1.
The later “выполняй задачи, считая, что я аппрувнул каждую” grants standing human
approval for each remaining task of this bounded rerun change, including verified
closure, with one subagent and commit per task. Verify and review each task before
proceeding. [Task 6.1 evidence](verification.md#task-61-standing-human-approval-and-accepted-scope)
records the exact message and accepted scope, superseding the original expectation
of a separate completed-result reply. Record evidence in this change's
`verification.md` as work proceeds; passing checks do not imply human acceptance.

## 1. Pure rerun parser and trusted attempt catalog

- [x] 1.1 Add a pure `src/rerun-command.ts` parser and adjacent tests for lowercase reserved token, whitespace/tab variants, safe positive decimal IDs, all malformed forms in the CLI delta, and ordinary-token preservation; verify the focused parser suite without wiring execution.
- [x] 1.2 Add session-local `src/chat-runs.ts` types/catalog for immutable full tasks, one increasing allocator, direct source links, and trusted settlement; test exact long/Unicode/whitespace tasks, all returned terminal outcomes, unknown/unsettled sources, safe-integer bounds, detached reads, and rerun chains with the focused catalog suite.
- [x] 1.3 Add atomic `(arrival window, source)` action receipts to the catalog; test pending duplicate delivery, duplicate delivery after settlement, distinct-window deliberate repeats, rejected sources consuming no numbers, ordinary repeats, and immutable source state with no I/O or model invocation.
- [x] 1.4 Record group 1 scope, focused test commands/results, build/format/diff checks, and review findings/fixes in `verification.md`; verify documentation matches the pure API and explicitly states that CLI rerun is not yet enabled before marking the group complete.

## 2. Input arrival identity with one shared reader

- [x] 2.1 Add an additive chat submission read carrying `{ line, windowId }` to `src/line-input.ts`, keeping approval `readLine` string results and one pending owner; use native-stream tests to verify identity assigned at arrival, startup buffering, and identity retained across later dequeue/prompt creation.
- [x] 2.2 Carry the submission identity through `runChatInput` while preserving a legacy-reader fallback for ordinary input; focused input tests must verify fresh post-settlement windows, whitespace, EOF draining, exact `/exit`, no overlapping chat/approval reads, and no identity assigned at dequeue for legacy adapters.
- [x] 2.3 Preserve envelope cleanup on cancellation, input error, and close, including partial native readline state and late approval resolution; verify existing line-input/terminal-approval/CLI-cancellation suites plus new tests for buffered envelopes and shared ownership in interactive and noninteractive modes.
- [x] 2.4 Document the input contract, legacy rerun rejection policy, buffered versus fresh semantics, and group 2 focused/build/format/diff checks in `verification.md`; review the native-reader evidence before marking the group complete.

## 3. Execution-owned identity and safe observation provenance

- [x] 3.1 Move ordinary run allocation into the trusted catalog in `src/cli-app.ts` and pass explicit identity to `src/observation-session.ts` before invocation; update observation and CLI tests to verify unchanged ordinary numbering, rejected/inspection input consuming no numbers, synchronous events, and active-controller installation before callbacks.
- [x] 3.2 Add immutable numeric source and fixed context-policy provenance to `src/run-observation.ts` creation/projection/settlement and accept it through observation-session; focused tests must verify direct links, source immutability, no raw task/action metadata retained, late callbacks, and clock/projection failures without affecting execution eligibility.
- [x] 3.3 Render source/policy labels in rerun headers, result cards, list rows, and inspection using `src/terminal-observation.ts`; focused formatter/view tests must verify ordinary output compatibility, safe long/redacted previews, frozen timing, answer nonduplication, and durable non-TTY output.
- [x] 3.4 Record the allocator migration and safe display contract with focused CLI/observation tests and build/format/diff checks in `verification.md`; review identity/event association and ensure display has no task-selection authority before marking the group complete.

## 4. Explicit rerun through the existing turn path

- [x] 4.1 Route `/rerun N` in `src/cli-app.ts` before ordinary submission, resolve the trusted source and action receipt, and keep malformed/unknown/unsettled/duplicate/legacy-reader outcomes local; add CLI tests proving safe diagnostics, no execution fallthrough, no number/transcript changes, and diagnostic-writer failure isolation.
- [x] 4.2 Submit accepted attempts with the exact full source task and current conversation through the normal controller/observation/`runConversationTurn` path; actual-loop faux tests must verify intervening corrections, no copied history, command/action metadata absent from model messages, fresh ten-step/tool budgets, all source outcomes, and direct rerun chains.
- [x] 4.3 Add temporary-workspace integration tests for reads after changed files and new patch preparation/complete-diff consent after an applied source patch; verify current bytes, old applied-byte preservation, denial leaving current bytes unchanged, no old proposal/consent replay, and non-TTY patch denial.
- [x] 4.4 Add cancellation/approval integration tests for source review cancellation then fresh rerun consent, cancellation of a rerun with held cleanup, and completion/cancellation arbitration; verify no early prompt, no reused signal, no automatic retry, and immutable source inspection including applied-patch/cancelled evidence.
- [x] 4.5 Exercise native arrival envelopes with duplicated normalized rerun lines before/during work and dequeued after settlement, then deliberate fresh-window input; verify one attempt/request stream per action, mixed ordinary/inspection/exit ordering, EOF drain, and command-like approval input denying without queued replay.
- [x] 4.6 Inject synchronous observation, renderer, projection, clock, and diagnostic failures during acceptance/settlement; verify one catalog reservation/receipt and normal runtime authority, then compare source inspections before/after and check late callbacks cannot alter either settled run.
- [x] 4.7 Add command help and rerun usage to `CONTRIBUTING.md`, including current context, present files, fresh approval, and buffered-action semantics; record focused tests/build/format/spec/diff checks and review findings in `verification.md`, verifying docs against exercised CLI behavior before marking the group complete.

## 5. Integrated demonstration and final verification

- [x] 5.1 Add `examples/run-rerun-demo.ts` and its captured transcript using a temporary fixture and faux provider; run it to verify an inspected cancelled/failed source, intervening context/file change, linked rerun, buffered duplicate suppression, fresh deliberate repeat, new patch consent, and unchanged source evidence without OAuth/network.
- [x] 5.2 Exercise the integrated scenario through a real local PTY for fresh-prompt identity, active duplicate input, patch approval ownership, and Ctrl+C recovery; record commands, assertions, output, and PTY/physical-keyboard/live-provider coverage limits in `verification.md` and verify no broader coverage is claimed.
- [x] 5.3 Run `npm test`, `npm run build`, `npm run format:check`, `npm run spec:check`, and `git diff --check`; resolve relevant findings and record the final results plus a requirement-to-evidence review in `verification.md`, then present the implemented scope and limits for human acceptance.

## 6. Closure after explicit result acceptance

- [x] 6.1 Record the human acceptance message and accepted scope only after it is received; verify it covers the completed rerun result and leaves allowlisted validation unapproved.
- [x] 6.2 Synchronize only implemented and verified CLI-chat/run-observation deltas after acceptance, preserving existing scenarios and permission boundaries; inspect the resulting current specs and run strict structural validation before archiving.
- [x] 6.3 Archive the accepted change and update `PRD.md`, `IMPLEMENTATION_PLAN.md`, and `CONTRIBUTING.md` links/state; verify local links, formatting, diff checks, and that validation is identified as a draft to rebase/review rather than an authorized implementation leaf.
