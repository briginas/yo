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
- **Next planning candidate:** Milestone 3, approval-gated patch proposal and
  application. Its
  [requirements](docs/requirements/milestone-3-approval-gated-patches.md) are
  approved and its
  [active implementation plan](docs/plans/active/milestone-3-approval-gated-patches.md)
  is ready for bounded execution. No runtime leaf is approved or implemented;
  the first candidate is **9.1, patch proposal contracts and limits**.

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
