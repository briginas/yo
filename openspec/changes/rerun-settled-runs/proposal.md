# Proposal: Explicit rerun of settled runs

## Why

After cancellation or another settled outcome, users can inspect a run but must
manually reconstruct its task to try again. Now that settlement and retained
inspection are implemented, an explicit linked attempt can reuse the exact task
without changing the earlier result or carrying patch consent forward.

## What Changes

- Add the between-turn command `/rerun N` for any settled run in the current
  session: completed, transport-failed, cancelled, or budget-exhausted.
- Repeat the source's complete original task, including whitespace, against the
  **current conversation** and current workspace files. The user selected this
  context policy on 2026-10-03. Preserve prior messages once and append one new
  task plus the new attempt's structured suffix.
- Allocate a new increasing run number, link it to the directly selected source,
  and retain the source's result, events, answer preview, and frozen timing.
- Give each accepted attempt the existing fresh budget and cancellation
  controller. Reuse the existing model/tool loop and exact patch workflow.
- Treat repeated delivery of one pending rerun action as one attempt, including
  duplicate command lines buffered before the next between-turn prompt. Permit
  the same source to be deliberately rerun after a fresh prompt.
- Show the source number and `current conversation` context policy in the new
  run's header, result, list, and retained inspection. Keep full task text out of
  the bounded display record.
- Preserve fresh complete-diff consent for every newly proposed patch. Never
  replay a stored proposal, approval response, tool call, or filesystem snapshot.

### Acceptance criteria

1. Valid `/rerun N` creates exactly one new linked attempt from a settled source;
   malformed, unknown, or unsettled selections remain local without allocating
   a run or contacting the model.
2. The next request contains the current conversation exactly once followed by
   the source's full task. The command and input identities are not model text.
3. Changed-file reads use present workspace bytes, and old applied patches stay
   applied. A new patch needs a newly prepared preview and fresh consent.
4. Duplicate deliveries during one action create no additional run, transcript
   suffix, budget, or model request; fresh input after settlement permits another
   intentional attempt, including a rerun of a rerun.
5. Inspection of the source is unchanged before, during, and after the attempt.
   Cancellation settles the new attempt through existing cleanup boundaries.
6. Native buffered input, deterministic faux transport/patch scenarios, and
   applicable repository checks verify these contracts before result acceptance.

### Authorization and deferred scope

The user's “делай” on 2026-10-03 authorized preparing this proposal and its design,
requirement deltas, and tasks. The subsequent “ok. continue” authorized group 1
initially. The later “выполняй задачи, считая, что я аппрувнул каждую” authorizes
the remaining rerun implementation tasks, one subagent and commit per task.
Groups 1–4 are implemented, scoped-checked, and agent-reviewed in
[verification.md](verification.md). CLI rerun is enabled through the existing
turn path and documented in [the development guide](../../../CONTRIBUTING.md#chat-commands-and-rerun).
Group 5 adds the checked integrated demonstration, real local PTY evidence, and
final full-suite/requirement review. The completed result awaits human acceptance.
Implementation approval does not record that acceptance, which remains required
before spec synchronization and archive.

Defer original-context snapshots, context selectors, branching, continuation of
an old loop, automatic retry, parallel runs, persistence, cross-session lookup,
rollback, validation/process tools, new providers, skills, MCP, and subagents.
The allowlisted-validation draft remains unapproved and follows verified rerun.

## Capabilities

### New Capabilities

None; extend the existing chat control and run observation boundaries.

### Modified Capabilities

- `cli-chat`: precisely recognize rerun input; own full source tasks, source
  eligibility, current-context submission, duplicate-action accounting, and
  reuse of the existing execution and fresh-consent boundaries.
- `run-observation`: display immutable source linkage and context policy on new
  records while preserving inspection-only behavior and safe display bounds.

## Impact

Affected areas are `src/cli-app.ts`, `src/line-input.ts`, local command parsing,
and a small trusted CLI run catalog; `src/observation-session.ts`,
`src/run-observation.ts`, and `src/terminal-observation.ts` receive safe provenance
for display. Focused tests sit beside those modules and the existing conversation,
cancellation, and approval integration tests; a faux demonstration belongs in
`examples/`. Runtime conversation/loop/transport and patch contracts should be
reused without new capabilities or dependencies.

This follows pi's session-owned submission and abort-and-wait separation with
terminal actions outside the model loop. Pi's fork/navigation and automatic
recovery are broader behaviors and are not imported. At accepted closure, update
the project maps and synchronize only verified deltas; main specs remain current
implemented behavior until then.
