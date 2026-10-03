# Implementation plan

This is the current project-state and sequencing map. Detailed implemented
requirements live in OpenSpec specifications; proposed work lives in OpenSpec
changes. Read the [workflow guide](CONTRIBUTING.md) before starting a change.

## Implemented behavior

- [Agent harness](openspec/specs/agent-harness/spec.md): bounded sequential loop,
  closed tool registry, workspace policy, settled cancellation, and read-tool limits.
- [CLI chat](openspec/specs/cli-chat/spec.md): the `yo` entrypoint, ephemeral
  transcript, sequential input, active/idle interrupt routing, and per-turn recovery.
- [Codex authentication and transport](openspec/specs/codex-auth-transport/spec.md):
  trusted OAuth, credential refresh/storage, cancellable requests, and safe answers.
- [Approval-gated patching](openspec/specs/approval-gated-patching/spec.md):
  exact single-file proposals, complete preview, fresh consent, revalidation,
  atomic application, and cancellation that preserves committed replacements.
- [Run observation](openspec/specs/run-observation/spec.md): session-local run
  history, requested/settled cancellation display, and local `/runs` and `/run N` inspection.

Milestones 1–4 are complete. Cancellation implementation and integration checks
now pass 466 tests, build, formatting, strict OpenSpec validation, and diff checks.
Its [archived verification](openspec/changes/archive/2026-10-02-cancel-active-runs/verification.md) records
review findings/fixes, deterministic demonstration, real PTY and process-SIGINT
checks, and the remaining physical-keyboard/live-provider coverage limits. Human
acceptance was received on 2026-10-02; the five current specifications are
synchronized and the cancellation change is archived.
The [archived inspection evidence](openspec/changes/archive/2026-10-02-inspect-settled-runs/verification.md)
retains the earlier Milestone 4 closure evidence.

Old milestone documents have been removed. Do not look for active/completed
plans under `docs/`; use the relevant change's proposal, design, deltas, and tasks.

## Completed increment: cancellation

[Cancellation](openspec/changes/archive/2026-10-02-cancel-active-runs/proposal.md)
is implemented and accepted. Its [design](openspec/changes/archive/2026-10-02-cancel-active-runs/design.md),
[requirement deltas](openspec/changes/archive/2026-10-02-cancel-active-runs/specs/),
[tasks](openspec/changes/archive/2026-10-02-cancel-active-runs/tasks.md), and
[verification](openspec/changes/archive/2026-10-02-cancel-active-runs/verification.md)
retain the completed evidence. The user authorized a commit after each step;
groups 5–7 are committed as `3a4406f`, `c67c608`, and `5aae91e`, with final
integration verification and the observation reentry fix in `755d9c9`.

The trusted controller propagates abort through credentials, transport, loop,
read tools, and exact patch review/application, then waits for full turn settlement.
Ctrl+C requests cancellation during active work and exits at the idle prompt.
Requested cancellation remains running while cleanup settles. Runtime aborted/aborted
renders cancelled; completion winning the race remains completed. Accepted calls
receive ordered results, applied patches remain applied, and cancelled evidence
is retained for inspection and the next turn. This follows pi's abort-and-wait
separation within yo's sequential scope.

The user explicitly accepted the verified result and authorized closure with
“it's ok. go” on 2026-10-02. Only verified cancellation deltas were synchronized;
the archive preserves earlier staged evidence and its coverage limits.
The explicit rerun planning artifacts below are prepared; groups 1–5 are
implemented, checked, and agent-reviewed. The user authorized the remaining rerun implementation
tasks with one subagent and commit per task; completed-result acceptance remains
separate.

## Subsequent work

1. **Explicit rerun:** the [proposal](openspec/changes/rerun-settled-runs/proposal.md),
   [design](openspec/changes/rerun-settled-runs/design.md),
   [deltas](openspec/changes/rerun-settled-runs/specs/), and
   [tasks](openspec/changes/rerun-settled-runs/tasks.md) are prepared for review.
   The user requested planning on 2026-10-03 and selected **current conversation**
   context. Implemented `/rerun N` creates a new numbered run linked to its settled
   source, repeats the exact task using current workspace state, retains the
   earlier attempt, and requires fresh patch consent. Arrival-window receipts
   prevent buffered duplicates while permitting a deliberate later attempt.
   The subsequent “ok. continue” initially authorized group 1. Its pure command parser,
   trusted catalog, and action receipts are implemented, agent-reviewed, and
   scoped-checked with 14 focused tests, build, formatting, strict OpenSpec
   validation, and diff checks; see [evidence](openspec/changes/rerun-settled-runs/verification.md).
   The later “выполняй задачи, считая, что я аппрувнул каждую” authorizes the remaining
   rerun implementation tasks, one subagent and commit per task. Group 2 adds
   trusted input-arrival identity with one shared reader and passes 52 focused
   input/approval/cancellation tests plus build, formatting, and diff checks.
   Group 3 moves ordinary run numbering to the trusted catalog and adds immutable
   safe source/policy provenance to observation and all four display surfaces.
   It passes 120 focused CLI/cancellation/observation/catalog tests plus build,
   formatting, strict OpenSpec validation, diff checks, and agent review.
   Group 4 enables command routing through the existing turn path and verifies
   exact tasks/current context, all settled source outcomes, fresh budgets and
   signals, changed-file reads, new complete-diff consent, cancellation settlement,
   source immutability, native arrival-window deduplication, and display-failure
   isolation. Local help and [usage](CONTRIBUTING.md#chat-commands-and-rerun) describe
   these controls. Tasks 1.1–4.7 are checked after scoped checks and agent review;
   the consolidated [group 4 evidence](openspec/changes/rerun-settled-runs/verification.md#group-4-cli-execution-usage-and-review)
   records results and limits. Group 5 verifies the repeatable faux rerun demonstration,
   real local PTY scenario, 568-test full suite, and all delta requirements/scenarios;
   [final evidence](openspec/changes/rerun-settled-runs/verification.md#task-53-final-regression-and-requirement-review)
   includes the repaired cancellation-demo wrapper and regenerated old transcripts.
   Tasks 1.1–5.3 are checked. The next boundary is task 6.1, human acceptance;
   completed-result acceptance is required before synchronization or archive.
2. **Allowlisted validation:** the imported
   [proposal](openspec/changes/allowlisted-validation/proposal.md),
   [design](openspec/changes/allowlisted-validation/design.md),
   [deltas](openspec/changes/allowlisted-validation/specs/allowlisted-validation/spec.md),
   and [tasks](openspec/changes/allowlisted-validation/tasks.md) remain unapproved.
   Rebase and review against verified cancellation/rerun contracts before starting
   its first implementation candidate, pure contracts/catalog/output bounds
   (former 11.1). Artifact completeness does not make this the next authorized task.
   Validation proposes exactly `test` and `build`, with outcomes in observation;
   npm scripts are trusted process code, not a filesystem/network sandbox.

## Permanent constraints

- No model-visible tool may perform an unapproved write, process, shell, network,
  credential, or connector action. Current trusted network access is limited to
  ChatGPT OAuth and the Codex transport.
- The verified harness may write its OAuth store at `~/.yo/auth.json` and apply
  one exact workspace patch only after explicit terminal consent.
- There is no current process/validation tool, API-key fallback, persistent
  session, JSONL, cross-session history, TUI,
  project runtime configuration, device-code login, multi-provider support,
  skills, MCP, or subagents.
- Draft requirements do not grant capabilities. Each new behavior needs reviewed
  OpenSpec artifacts, confirmation of its bounded leaf, scoped checks, and result
  review before completion or synchronization into main specifications.
