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

Milestones 1–4 are complete. The last recorded full implementation check passed
341 tests, build, formatting, strict OpenSpec validation, and diff checks.
The [archived inspection evidence](openspec/changes/archive/2026-10-02-inspect-settled-runs/verification.md)
records 10.3–10.4 self-review and faux terminal verification. Physical TTY and
live-provider behavior were not newly verified for observation closure.

Old milestone documents have been removed. Do not look for active/completed
plans under `docs/`; use the relevant change's proposal, design, deltas, and tasks.

## Next planning boundary: cancellation

Create a separate OpenSpec change before implementation. A trusted controller
must propagate abort through transport, loop, tools, and pending approval, and
wait for settlement. Display cancellation requested while work settles; display
cancelled only after runtime confirmation. If completion wins the race, preserve
completion. Already applied patches remain applied.

Review cancellation before execution, during model/tool/approval work, repeated
requests, and both completion/cancellation race orders. Follow pi's session
abort-and-wait separation while preserving yo's sequential scope. Confirm the
first bounded implementation leaf with the user after the design review.

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
  session, JSONL, cross-session history, user-controlled cancellation/rerun, TUI,
  project runtime configuration, device-code login, multi-provider support,
  skills, MCP, or subagents.
- Draft requirements do not grant capabilities. Each new behavior needs reviewed
  OpenSpec artifacts, confirmation of its bounded leaf, scoped checks, and result
  review before completion or synchronization into main specifications.
