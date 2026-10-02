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
The next candidate is explicit rerun planning below; no implementation leaf is
currently approved.

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
