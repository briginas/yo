# Tasks

These tasks implement only M4 leaf 10.3, explicitly authorized on 2026-10-02.
All tasks are complete with checks and agent self-review recorded in
[verification.md](verification.md). The command/layout decision is recorded
in the proposal. Leaf 10.4 and whole-milestone closure stay pending; independent
review and human acceptance of this implementation are not claimed.

## 1. Pure command parsing and retained-record presentation

- [x] 1.1 Add a narrow pure inspection-command parser with `type` contracts; verify valid syntax, whitespace, missing/extra arguments, zero/negative/leading-zero/fraction/exponent/overflow IDs, and unrelated slash text with `node --test src/observation-command.test.ts`.
- [x] 1.2 Extract shared list/card formatting and add settled-run inspection formatting; verify empty history, stop reasons, isolated ordered feeds, call association, tool truncation, answer truncation/absence, safe previews, and frozen/unavailable timing with `node --test src/terminal-observation.test.ts`, preserving automatic once-per-turn answer delivery.
- [x] 1.3 Record the parser and formatter checks plus code-review findings in this change before starting CLI integration; verify no runtime behavior or generated skills changed in the diff.

## 2. Between-turn routing and input ownership

- [x] 2.1 Route local commands in `cli-app.ts` before observation creation using `getHistory()`; verify empty/missing/running selections and that valid/invalid commands allocate no runs, sample no clocks, invoke no turns, and preserve ordinary-message bytes in focused CLI tests.
- [x] 2.2 Isolate inspection rendering and diagnostics; inject failures in both writers and verify subsequent chat, last-session outcome, model messages, and retained evidence remain correct with `node --test src/cli-observation.test.ts`.
- [x] 2.3 Verify pending model/tool work starts no additional chat read using controlled promises; extend approval fixtures to prove command-like responses are denied and consumed solely by the approver, later viewing grants no consent, fresh patches still need approval, and non-TTY approval remains denied. Run the CLI observation, line-input, and terminal-approval test files together.
- [x] 2.4 Document `/runs`, `/run N`, reserved-token behavior, retained-answer limits, and between-turn availability in README; link this in-progress change from project maps and the active plan while preserving pending 10.4 status. Check examples against tested input and review routing/approval changes before checking this group complete.

## 3. Multi-turn acceptance and reproducible demonstration

- [x] 3.1 Add integrated flows for success, transport/tool errors, budget exhaustion, repeated selection, invalid selection, and follow-up chat; compare captured model requests and sequential run IDs against flows without inspection, and verify a fresh CLI session starts empty with the focused CLI suite.
- [x] 3.2 Extend `docs/examples/run-observation-demo.ts` and its captured transcript with empty/list/selected/failed-run views and continued chat; run the faux demo using injected clocks, controlled delays, and temporary patch fixtures without OAuth or network, and document which TTY behavior remains unverified.
- [x] 3.3 Run `npm test`, `npm run build`, `npm run format:check`, `npm run spec:check`, and `git diff --check`; review the scoped terminal flow and execution/consent boundaries, resolve findings, and record exact results before marking 10.3 complete. Keep 10.4 and whole-milestone closure unchecked.

## 4. Verified specification ownership

- [x] 4.1 After implementation checks and result review, synchronize only verified delta requirements through the spec-sync workflow; update the main spec Purpose and ownership links in PRD, IMPLEMENTATION_PLAN, the M4 requirements/active plan, and `docs/openspec.md` to include 10.3 while retaining 10.4 and deferred work. Verify strict spec validation, formatting, link targets, and a final scope review; preserve historical evidence and do not infer human acceptance or archive automatically.
