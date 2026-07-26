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
  application. It has no approved requirements, implementation plan, or
  candidate leaf yet; the harness remains read-only until those documents and
  a bounded leaf are separately approved.

## Permanent constraints

- No model-visible write, shell, process, network, credential, or connector
  tools.
- Trusted network access remains limited to ChatGPT OAuth and the OpenAI Codex
  model transport.
- The only trusted persistent filesystem write remains the OAuth credential
  store at `~/.yo/auth.json`; no writes are allowed inside the approved
  workspace.
- No API-key fallback, persistent sessions, JSONL, compaction, TUI, project
  configuration file, device-code login, multi-provider support, skills, MCP,
  or subagents exist in the current verified harness.
- Do not implement Milestone 3 behavior until its requirements, detailed plan,
  and first bounded leaf are approved.
