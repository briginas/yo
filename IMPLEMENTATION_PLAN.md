# Implementation plan

This is the current project-state and sequencing map. Detailed implemented
requirements live in OpenSpec specifications; proposed work lives in OpenSpec
changes. Read the [workflow guide](CONTRIBUTING.md) before starting a change.

## Implemented behavior

- [Agent harness](openspec/specs/agent-harness/spec.md): bounded sequential loop,
  closed tool registry, workspace policy, and read-tool limits.
- [CLI chat](openspec/specs/cli-chat/spec.md): the `yo` entrypoint, ephemeral
  transcript, sequential input, and recoverable turn failures.
- [Codex authentication and transport](openspec/specs/codex-auth-transport/spec.md):
  trusted OAuth, credential refresh/storage, provider conversion, and safe answers.
- [Approval-gated patching](openspec/specs/approval-gated-patching/spec.md):
  exact single-file proposals, complete preview, fresh consent, revalidation,
  and atomic application.
- [Run observation](openspec/specs/run-observation/spec.md): session-local run
  history, live display, and local `/runs` and `/run N` inspection.

Milestones 1–4 are complete. Cancellation implementation and integration checks
now pass 466 tests, build, formatting, strict OpenSpec validation, and diff checks.
Its [verification](openspec/changes/cancel-active-runs/verification.md) records
review findings/fixes, deterministic demonstration, real PTY and process-SIGINT
checks, and the remaining physical-keyboard/live-provider coverage limits. Human
acceptance and main-spec synchronization remain pending.
The [archived inspection evidence](openspec/changes/archive/2026-10-02-inspect-settled-runs/verification.md)
retains the earlier Milestone 4 closure evidence.

Old milestone documents have been removed. Do not look for active/completed
plans under `docs/`; use the relevant change's proposal, design, deltas, and tasks.

## Current change: cancellation review

[Cancellation](openspec/changes/cancel-active-runs/proposal.md) is implemented
through groups 1–7 and integration tasks 8.1–8.2. Its [design](openspec/changes/cancel-active-runs/design.md),
[requirement deltas](openspec/changes/cancel-active-runs/specs/), [tasks](openspec/changes/cancel-active-runs/tasks.md),
and [verification](openspec/changes/cancel-active-runs/verification.md) remain
active until explicit result acceptance. The user authorized the remaining
implementation with a commit after each step; groups 5–7 are committed as
`3a4406f`, `c67c608`, and `5aae91e`.

The trusted controller propagates abort through credentials, transport, loop,
read tools, and exact patch review/application, then waits for full turn settlement.
Ctrl+C requests cancellation during active work and exits at the idle prompt.
Requested cancellation remains running while cleanup settles. Runtime aborted/aborted
renders cancelled; completion winning the race remains completed. Accepted calls
receive ordered results, applied patches remain applied, and cancelled evidence
is retained for inspection and the next turn. This follows pi's abort-and-wait
separation within yo's sequential scope.

The only remaining task is 8.3: after the user accepts this verified result,
synchronize the implemented deltas, archive the change, and update these links.
Automated checks and agent review do not infer acceptance. Main specifications
remain unchanged until that gate is satisfied.

## Subsequent work

1. **Explicit rerun:** separately specify original-snapshot versus current-context
   policy. Create a new numbered run linked to its source, use current workspace
   state, retain the previous attempt, and require fresh patch consent. Repeated
   submission of one pending rerun action must not allocate duplicate runs; a
   deliberate later attempt remains possible. Verify source immutability, changed
   files, terminal source runs, repeated input, and absence of automatic retries.
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
  session, JSONL, cross-session history, rerun, TUI,
  project runtime configuration, device-code login, multi-provider support,
  skills, MCP, or subagents.
- Draft requirements do not grant capabilities. Each new behavior needs reviewed
  OpenSpec artifacts, confirmation of its bounded leaf, scoped checks, and result
  review before completion or synchronization into main specifications.
