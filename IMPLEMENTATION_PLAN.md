# Implementation plan

This is the current project-state and sequencing map. Detailed implemented
requirements live in OpenSpec specifications; proposed work lives in OpenSpec
changes. Read the [workflow guide](CONTRIBUTING.md) before starting a change.

## Implemented behavior

- [Agent harness](openspec/specs/agent-harness/spec.md): bounded sequential loop,
  closed tool registry, workspace policy, settled cancellation, and read-tool limits.
- [CLI chat](openspec/specs/cli-chat/spec.md): the `yo` entrypoint, ephemeral
  transcript, sequential input, active/idle interrupt routing, per-turn recovery,
  and explicit settled-run rerun.
- [Codex authentication and transport](openspec/specs/codex-auth-transport/spec.md):
  trusted OAuth, credential refresh/storage, cancellable requests, and safe answers.
- [Approval-gated patching](openspec/specs/approval-gated-patching/spec.md):
  exact single-file proposals, complete preview, fresh consent, revalidation,
  atomic application, and cancellation that preserves committed replacements.
- [Run observation](openspec/specs/run-observation/spec.md): session-local run
  history, requested/settled cancellation display, local `/runs` and `/run N` inspection,
  and safe direct rerun provenance.

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

## Completed increment: explicit rerun

The [proposal](openspec/changes/archive/2026-10-03-rerun-settled-runs/proposal.md),
[design](openspec/changes/archive/2026-10-03-rerun-settled-runs/design.md),
[deltas](openspec/changes/archive/2026-10-03-rerun-settled-runs/specs/),
[tasks](openspec/changes/archive/2026-10-03-rerun-settled-runs/tasks.md), and
[verification](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md)
retain the completed rerun increment. All **25/25** tracked tasks are checked;
the verified CLI-chat and run-observation deltas are synchronized into current
specs and the change is archived.

`/rerun N` creates a new numbered attempt linked directly to its settled source,
repeats the complete exact task with current conversation/workspace state, and
retains the source evidence. Each attempt gets fresh budgets and cancellation,
and each new patch requires new preparation and complete-diff consent.
Trusted input-arrival windows suppress buffered duplicates while fresh prompts
permit deliberate later attempts. Inspection and rejected actions stay local.
This follows pi's session-owned submission and presentation separation in yo's
smaller sequential, in-memory scope; branches, persistence, rollback, automatic
retries, parallel runs, and broader capabilities remain deferred.

The user requested planning on 2026-10-03 and selected current conversation.
The subsequent “ok. continue” initially approved group 1; the later “выполняй
задачи, считая, что я аппрувнул каждую” granted standing approval for every task
of this bounded rerun change, including verified closure, with one subagent and
commit per task. [Task 6.1](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md#task-61-standing-human-approval-and-accepted-scope)
records the exact instruction, without inventing a later acceptance reply or
personal human review of completed checks. [Final verification](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md#task-53-final-regression-and-requirement-review)
records 568 passing tests, build, demonstrations, requirement review, and real
local PTY evidence with a faux provider. Physical-keyboard, terminal-emulator UX,
and live-provider coverage remain outside that evidence.
[Task 6.2](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md#task-62-verified-specification-synchronization)
and [task 6.3](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md#task-63-archive-and-project-map-closure)
record synchronization and archival checks; [usage](CONTRIBUTING.md#chat-commands-and-rerun)
describes the implemented controls.

## Next planning candidate: compatibility review of the validation draft

The separately confirmed [dim technical output](openspec/changes/dim-technical-output/proposal.md)
presentation leaf is implemented and verified. Its [design](openspec/changes/dim-technical-output/design.md),
[delta](openspec/changes/dim-technical-output/specs/run-observation/spec.md),
[task](openspec/changes/dim-technical-output/tasks.md), and
[evidence](openspec/changes/dim-technical-output/verification.md) record the small
CLI-only scope, 581 passing tests, and successful build and repository checks.
Completed-result human review, synchronization, and archival remain pending.
It adds no execution capability or authorization for the validation draft below.

The imported allowlisted-validation
[proposal](openspec/changes/allowlisted-validation/proposal.md),
[design](openspec/changes/allowlisted-validation/design.md),
[deltas](openspec/changes/allowlisted-validation/specs/allowlisted-validation/spec.md),
and [tasks](openspec/changes/allowlisted-validation/tasks.md) remain unapproved.
Complete the broader review of their assumptions and deltas against the
now-current cancellation/rerun contracts before proposing or confirming an
implementation leaf. Pure contracts/catalog/output bounds (former 11.1) remain a later
implementation candidate, not an authorized next task.

The [limited CLI delta repair](openspec/changes/allowlisted-validation/tasks.md#limited-cli-delta-repair-2026-10-03)
restores `Rerun after budget exhaustion` and `Failure without explicit request`
verbatim, together with the current settled cancellation/rerun and no-auto-retry
text. Only the existing proposed read/patch versus validation timeout distinction
remains in that budget block. Global `npm run spec:check` now passes the five
current specs and this draft. Task 0.1 remains unchecked: remaining design
assumptions and the full compatibility diff still require review. Product/platform
approval and all validation implementation tasks also remain pending.
The user authorized this documentation repair and its commit; that approval
and artifact completeness do not authorize validation.
The draft proposes exactly `test` and `build`, with outcomes in observation;
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
