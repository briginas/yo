# Implementation plan

This file is the current project-state map. Read linked completed requirements
only for behavior, regression, or compatibility work.

Before starting a new milestone, create and approve its requirements and
detailed implementation plan, then confirm its first bounded leaf.

## Current state

- **Completed baseline:** Milestone 1, the read-only `yo ask` harness, was
  completed and verified on 2026-07-24. See the
  [completed Milestone 1 summary](docs/plans/completed/milestone-1-read-only-ask.md).
- **Completed interactive chat:** Milestone 2 was completed and verified on
  2026-07-26. See its
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
  The next planning candidate is **Milestone 4: narrowly allowlisted validation
  commands**; no implementation is authorized yet.

## Permanent constraints

- No model-visible tool may directly perform an unapproved write, shell,
  process, network, credential, or connector action.
- Trusted network access remains limited to ChatGPT OAuth and the OpenAI Codex
  model transport.
- The current verified harness writes only the OAuth credential store at
  `~/.yo/auth.json`; it does not write inside the approved workspace.
- Any future workspace mutation must be separately specified, approved, and
  enforced by trusted harness code rather than model instructions.
- No API-key fallback, persistent sessions, JSONL, compaction, TUI, project
  configuration file, device-code login, multi-provider support, skills, MCP,
  or subagents exist in the current verified harness.
- Do not implement Milestone 3 behavior until its requirements, detailed plan,
  and current bounded leaf are approved.
