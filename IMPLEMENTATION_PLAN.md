# Implementation plan

This file is the current project-state map. Read linked completed requirements
only for behavior, regression, or compatibility work.

Before starting a new milestone, create and approve its requirements and
detailed implementation plan, then confirm its first bounded leaf.

## Current state

- **Historical baseline:** Milestone 1, the read-only `yo ask` harness, was
  completed and verified on 2026-07-24, then its one-shot CLI command was
  retired after chat became the single agent workflow. See the
  [completed Milestone 1 summary](docs/plans/completed/milestone-1-read-only-ask.md)
  for the historical implementation.
- **Completed interactive chat:** Milestone 2 was completed and verified on
  2026-07-26. The interactive workflow is now invoked directly as `yo`, with
  optional `--cwd` and `--model` flags. See its
  [requirements](docs/requirements/milestone-2-in-memory-chat.md) and
  [completed Milestone 2 summary](docs/plans/completed/milestone-2-in-memory-chat.md).
- **Completed approval-gated patches:** Milestone 3, approval-gated patch proposal
  and application, was verified on 2026-07-27. Its
  [requirements](docs/requirements/milestone-3-approval-gated-patches.md) are
  approved and its
  [completed plan summary](docs/plans/completed/milestone-3-approval-gated-patches.md)
  records **9.1–9.10, patch contracts, pure transform, immutable proposal
  preparation, approval vocabulary, guarded atomic application, controlled
  dispatcher integration, approval propagation through the agent loop and
  conversation, terminal diff rendering, model-visible CLI/provider composition,
  deterministic end-to-end coverage, and a real OAuth-backed approval flow**.
- **Drafted allowlisted validation:** Milestone 4 requirements and its active
  plan were prepared on 2026-07-27 for review:
  [requirements](docs/requirements/milestone-4-allowlisted-validation.md) and
  [active plan](docs/plans/active/milestone-4-allowlisted-validation.md).
  The proposed boundary is one `run_validation` tool with exactly `test` and
  `build`. The documents remain draft, no implementation is authorized, and
  the first candidate after approval is **10.1: validation contracts, fixed
  catalog, and pure bounded-output accumulation**.

## Permanent constraints

- No model-visible tool may directly perform an unapproved write, shell,
  process, network, credential, or connector action.
- Trusted network access remains limited to ChatGPT OAuth and the OpenAI Codex
  model transport. Proposed Milestone 4 npm scripts are explicitly documented
  as trusted process code rather than a network sandbox.
- The current verified harness writes the OAuth credential store at
  `~/.yo/auth.json` and may atomically apply one exact workspace patch after
  explicit terminal approval.
- Any future workspace mutation must be separately specified, approved, and
  enforced by trusted harness code rather than model instructions.
- No API-key fallback, persistent sessions, JSONL, compaction, TUI, project
  configuration file, device-code login, multi-provider support, skills, MCP,
  or subagents exist in the current verified harness.
- Do not implement Milestone 4 behavior until its draft requirements and active
  plan are reviewed and approved and one bounded leaf is confirmed.
