# Implementation plan

This file is the current project-state map. Read the linked active plan before
proposing or implementing work on its milestone.

Run and review the scoped checks for each leaf item before moving to the next
one. Confirm the first incomplete leaf with the user before implementation.

## Current state

- **Completed baseline:** Milestone 1, the read-only `yo ask` harness, was
  completed and verified on 2026-07-24. See the
  [completed Milestone 1 summary](docs/plans/completed/milestone-1-read-only-ask.md).
- **Active milestone:** Milestone 2, in-memory interactive chat. Its
  [requirements](docs/requirements/milestone-2-in-memory-chat.md) and
  [active implementation plan](docs/plans/active/milestone-2-in-memory-chat.md)
  are the detailed sources of truth.
- **Next candidate leaf:** `8.3.2 Format safe status summaries`.
  Milestone 2 has completed the verified public event-observer boundary,
  bounded in-memory turn continuation, and the internal terminal-renderer
  boundary.

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
  or subagents in Milestone 2.
- Do not mark a leaf complete until its scoped checks pass and its result is
  reviewed.
