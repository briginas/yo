# Implementation plan

This file is the current project-state map. Read linked completed requirements
only for behavior, regression, or compatibility work.

Before starting a new milestone, create and approve its requirements and
detailed implementation plan, then confirm its first bounded leaf.

For OpenSpec development tooling and source ownership, read
[the workflow guide](docs/openspec.md). Current implemented requirements live in:

- [agent harness](openspec/specs/agent-harness/spec.md);
- [CLI chat](openspec/specs/cli-chat/spec.md);
- [Codex authentication and transport](openspec/specs/codex-auth-transport/spec.md);
- [approval-gated patching](openspec/specs/approval-gated-patching/spec.md);
- [run observation](openspec/specs/run-observation/spec.md).

Completed milestone plans retain implementation and verification records.
The user authorized the Milestone 1–3 baseline migration on 2026-10-02 and
requested removal of the former requirement files. This documentation migration
adds no runtime capability and does not authorize the next feature milestone.

## Current state

- **Historical baseline:** Milestone 1, the read-only `yo ask` harness, was
  completed and verified on 2026-07-24, then its one-shot CLI command was
  retired after chat became the single agent workflow. See the
  [completed Milestone 1 summary](docs/plans/completed/milestone-1-read-only-ask.md)
  for the historical implementation.
- **Completed interactive chat:** Milestone 2 was completed and verified on
  2026-07-26. The interactive workflow is now invoked directly as `yo`, with
  optional `--cwd` and `--model` flags. See its
  [current requirements](openspec/specs/cli-chat/spec.md) and
  [completed Milestone 2 summary](docs/plans/completed/milestone-2-in-memory-chat.md).
- **Completed approval-gated patches:** Milestone 3, approval-gated patch proposal
  and application, was verified on 2026-07-27. Its
  [current requirements](openspec/specs/approval-gated-patching/spec.md) are
  maintained in OpenSpec and its
  [completed plan summary](docs/plans/completed/milestone-3-approval-gated-patches.md)
  records **9.1–9.10, patch contracts, pure transform, immutable proposal
  preparation, approval vocabulary, guarded atomic application, controlled
  dispatcher integration, approval propagation through the agent loop and
  conversation, terminal diff rendering, model-visible CLI/provider composition,
  deterministic end-to-end coverage, and a real OAuth-backed approval flow**.
- **Completed run observation (10.1–10.4):** session-local records, live observation,
  and between-turn inspection are implemented. The user selected `/runs` and
  `/run N` and authorized leaf 10.3 on 2026-10-02. All 341 tests and project
  checks passed; agent self-review and the faux demo are recorded in the
  [change evidence](openspec/changes/archive/2026-10-02-inspect-settled-runs/verification.md).
  No independent or human review of this implementation is claimed.
  Current requirements live in the [OpenSpec specification](openspec/specs/run-observation/spec.md).
  Earlier decisions and evidence remain in the [completed plan](docs/plans/completed/milestone-4-run-observation.md).
  The user authorized 10.4 closure and a final commit. Closure passed 64
  focused checks, all 341 tests, repository checks, and agent self-review of
  the repeatable terminal flow. The OpenSpec change is archived.
  **Next: separately plan and approve cancellation.**
- **Later cancellation:** after the first observation version is verified,
  separately specify and approve a trusted cancellation controller with
  propagation and settle-before-return behavior.
- **Later explicit rerun:** after cancellation, separately specify and approve
  a new linked run, its context policy, and fresh patch consent; no automatic
  retry is planned.
- **Draft validation and results:** after those preceding increments, review
  the existing [Milestone 5 requirements](docs/requirements/milestone-5-allowlisted-validation.md)
  and [draft plan](docs/plans/active/milestone-5-allowlisted-validation.md).
  Its one `run_validation` tool remains limited to `test` and `build`; leaves
  **11.1–11.7** also include outcomes in the observation feed and result card.
  No process implementation is authorized yet.

## Permanent constraints

- No model-visible tool may directly perform an unapproved write, shell,
  process, network, credential, or connector action.
- Trusted network access remains limited to ChatGPT OAuth and the OpenAI Codex
  model transport. Milestone 4 observation adds no network capability.
  Proposed Milestone 5 npm scripts are explicitly
  documented as trusted process code rather than a network sandbox.
- The current verified harness writes the OAuth credential store at
  `~/.yo/auth.json` and may atomically apply one exact workspace patch after
  explicit terminal approval.
- Any future workspace mutation must be separately specified, approved, and
  enforced by trusted harness code rather than model instructions.
- No API-key fallback, persistent sessions, JSONL, cross-session run-history inspection,
  user-controlled run cancellation or rerun, TUI, project configuration file,
  device-code login, multi-provider support, skills, MCP, or subagents exist
  in the current verified harness.
- Milestone 4 leaves 10.1–10.4 are complete with recorded checks and review.
  Confirm the next bounded milestone before implementation.
- Cancellation and explicit rerun remain separately planned later increments;
  approval of first-version observation does not authorize them.
- Do not implement Milestone 5 validation until observation, cancellation, and
  explicit rerun are verified and the validation draft is separately reviewed
  and approved against their settled contracts.
