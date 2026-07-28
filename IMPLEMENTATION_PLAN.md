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
- **Approved context compaction:** Milestone 4 requirements and its active plan
  were approved on 2026-07-28:
  [requirements](docs/requirements/milestone-4-context-compaction.md) and
  [active plan](docs/plans/active/milestone-4-context-compaction.md).
  The proposed boundary separates the complete in-memory transcript from the
  active model context and adds one structured summary lifecycle with a
  separately configurable compaction model. No runtime implementation has
  started, and the first candidate awaiting explicit confirmation is **10.1:
  compaction contracts, estimates, and complete-turn preparation**.
- **Renumbered allowlisted validation draft:** The former Milestone 4
  validation documents were renumbered on 2026-07-28 without runtime change:
  [Milestone 5 requirements](docs/requirements/milestone-5-allowlisted-validation.md)
  and [active plan](docs/plans/active/milestone-5-allowlisted-validation.md).
  Its proposed boundary remains one `run_validation` tool with exactly `test`
  and `build`; its implementation leaves are now **11.1–11.7**.

## Permanent constraints

- No model-visible tool may directly perform an unapproved write, shell,
  process, network, credential, or connector action.
- Trusted network access remains limited to ChatGPT OAuth and the OpenAI Codex
  model transport. Proposed Milestone 4 summarization stays inside that trusted
  provider infrastructure. Proposed Milestone 5 npm scripts are explicitly
  documented as trusted process code rather than a network sandbox.
- The current verified harness writes the OAuth credential store at
  `~/.yo/auth.json` and may atomically apply one exact workspace patch after
  explicit terminal approval.
- Any future workspace mutation must be separately specified, approved, and
  enforced by trusted harness code rather than model instructions.
- No API-key fallback, persistent sessions, JSONL, compaction, TUI, project
  configuration file, device-code login, multi-provider support, skills, MCP,
  or subagents exist in the current verified harness.
- Do not implement Milestone 4 behavior until one bounded leaf from its approved
  requirements and active plan is explicitly confirmed.
- Do not implement Milestone 5 validation until Milestone 4 is completed and
  the renumbered validation draft is separately reviewed and approved.
