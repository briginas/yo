# Proposal

## Why

The CLI retains current-session run records but cannot show an earlier run on
request. Milestone 4 leaf 10.3 makes that existing evidence inspectable between
tasks without changing execution or the model's conversation.

## What Changes

- Add `/runs` for the current-session list and `/run N` for one settled run's
  header, ordered events, retained answer preview, and result card. Return to
  `yo>` after each command; no persistent selection mode.
- Display missing answers and preview truncation explicitly. Preserve frozen
  timing, safe summaries, call association, and recorded patch outcomes.
- Handle empty history, invalid syntax, unknown numbers, and display failures
  locally, without allocating a run or sending input to the model.
- Preserve the terminal approver's exclusive input ownership. Local navigation
  is dispatched only at the ordinary chat prompt between turns.
- **BREAKING:** reserve `/runs` and `/run` command tokens at the chat prompt,
  including malformed arguments; these inputs previously became model tasks.
  Other text, including unrelated slash commands, retains existing behavior.

The user selected this command syntax and the retained-answer layout on
2026-10-02. This change prepares leaf 10.3 only; artifact readiness does not
record implementation approval or completion.

Acceptance: deterministic multi-turn flows can inspect completed and failed
runs, switch between their evidence, and continue chat with identical model
messages, run numbering, permissions, and patch-consent semantics. Keyboard and
non-TTY output remain usable. Scoped tests, project checks, and result review
must pass before marking 10.3 complete.

Deferred: leaf 10.4 milestone-wide closure, cancellation, rerun, validation
execution, persistence, full-transcript browsing, arrow-key navigation, paging,
new tools, dependencies, or runtime capabilities.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `run-observation`: permit current-session settled-run inspection; define
  local navigation, retained-answer presentation, and execution isolation.

## Impact

Expected code scope: a small pure command parser, CLI routing in
`src/cli-app.ts`, and formatters in `src/terminal-observation.ts`. Reuse
`ObservationSession.getHistory()` and existing safe records; the runtime,
provider, permission policy, and patch approver need no behavior changes.

Add focused parser/renderer/CLI checks and extend the existing faux demo.
Update README and source-ownership/project-map links when implementation is
verified. Main specs continue to describe 10.1–10.2 until reviewed sync; the
remaining M4 requirements still own milestone-wide closure and deferred scope.
