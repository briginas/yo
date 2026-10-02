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
- **Run observation, leaf 10.1 complete and reviewed:** On 2026-10-01, the next roadmap direction was
  selected as a current-session run list, event feed, and result card with
  errors and patch-approval state. See the new
  [Milestone 4 requirements](docs/requirements/milestone-4-run-observation.md)
  and [active plan](docs/plans/active/milestone-4-run-observation.md).
  On 2026-10-02 the user endorsed this direction and authorized only
  **10.1: session-local run records and pure event projection**. Its standalone
  implementation passed checks and was accepted after human review on the same
  date. The user then accepted the 10.2 live layout and separately authorized its
  implementation. CLI integration is complete after checks and independent review, under the user’s instruction to finish and commit.
  Leaves **10.3–10.4** require separate confirmation, and navigation is undecided.
  The implemented 10.2 order is record creation/insertion, identity-bound
  observer preparation, then turn invocation. Missing-record diagnostics and
  synchronous-event integration checks are implemented, distinct from the
  settled-record guard.
- **Later cancellation:** after the first observation version is verified,
  separately specify and approve a trusted cancellation controller with
  propagation and settle-before-return behavior.
- **Later explicit rerun:** after cancellation, separately specify and approve
  a new linked run, its context policy, and fresh patch consent; no automatic
  retry is planned.
- **Draft validation and results:** after those preceding increments, review
  the existing [Milestone 5 requirements](docs/requirements/milestone-5-allowlisted-validation.md)
  and [active plan](docs/plans/active/milestone-5-allowlisted-validation.md).
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
- No API-key fallback, persistent sessions, JSONL, run-history inspection,
  user-controlled run cancellation or rerun, TUI, project configuration file,
  device-code login, multi-provider support, skills, MCP, or subagents exist
  in the current verified harness.
- Milestone 4 leaf 10.1 is complete and reviewed; 10.2 is complete after checks and independent review under the user’s finish-and-commit instruction. Confirm the next bounded leaf before further implementation.
- Cancellation and explicit rerun remain separately planned later increments;
  approval of first-version observation does not authorize them.
- Do not implement Milestone 5 validation until observation, cancellation, and
  explicit rerun are verified and the validation draft is separately reviewed
  and approved against their settled contracts.
