# PRD: Read-only CLI Coding-Agent Harness

This file is the stable product map. Read the linked OpenSpec specifications and change artifacts for the affected scope.

## Objective

Build a small TypeScript command-line coding agent for learning how an agent
harness works. In an interactive chat over an approved workspace, the agent may
inspect repository files and return evidence-backed answers or plans.

The project takes architectural inspiration from [`pi`](../pi): a model invokes
typed tools through a controlled loop, and the harness validates, executes,
records, and returns observations. `yo` deliberately implements smaller,
independently verifiable slices of that design.

## Stable harness behavior

### Agent loop

1. Canonicalize `--cwd`, or the current directory when that flag is omitted,
   as the sole allowed workspace root and read one chat task at a time.
2. Build the model context from a stable system prompt, the user task, visible
   tool schemas, and prior structured observations.
3. Ask the model for either a final response or one or more tool calls.
4. For each tool call, validate the schema and evaluate the permission policy.
5. Execute allowed calls, cap their output, and append exactly one structured
   result per call.
6. Repeat until the model returns a final answer, the step budget is reached,
   the run is aborted, or an unrecoverable transport error occurs.

Every requested tool call receives a result: success, invalid arguments, unknown
tool, denied access, timeout, execution error, or aborted. The model never
directly accesses the filesystem.

### Permissions and bounds

- All tool paths must resolve inside `--cwd`; attempts to escape it are denied.
- Filesystem inspection tools are read-only. The only model-proposed workspace
  mutation is one exact `propose_patch` flow that trusted harness code applies
  only after explicit terminal approval.
- The verified registry exposes no process, shell, general write, network,
  credential, or connector capability.
- OAuth and model requests run only in trusted CLI infrastructure outside the
  model tool registry.
- The CLI may write its OAuth credential store at `~/.yo/auth.json` and may
  atomically apply one explicitly approved patch inside the workspace.
- Tool outputs have line/result/byte caps and expose truncation metadata.
- Runs have a fixed step budget and per-tool timeout.
- Secrets must not be printed in traces or included in model context.

### Observability

Record structured events without hidden reasoning:

- run start/end and stop reason;
- model request/response metadata;
- tool requested, allowed or denied, completed, timed out, or failed;
- final answer and evidence summary.

The CLI displays the final answer, files/tools used, and completion status.

## Stable public boundaries

Keep the runtime independent of the CLI and OpenAI transport through these core
concepts:

- `ToolDefinition`: name, description, input schema, risk class, executor, and
  result limits.
- `ToolCall`: model-requested tool name, identifier, and arguments.
- `ToolResult`: call identifier, status, content, metadata, and error details
  when relevant.
- `PermissionDecision`: `allow` or `deny`, with a machine-readable reason.
- `RunEvent`: an auditable lifecycle event emitted by the loop.
- `SessionState`: in-memory task, messages/observations, workspace root, budgets,
  and current run status.

The first provider adapter converts between these interfaces and OpenAI Codex
tool calling authenticated through ChatGPT OAuth. A faux adapter implements the
same boundary for tests.

The public CLI also exposes:

- `yo [--cwd <workspace>] [--model <name>]` as the only agent workflow;
- `yo login` to complete browser OAuth through the OpenAI website;
- `yo auth status` to report non-secret authentication state;
- `yo logout` to remove the stored OAuth credential.

## Requirement map

- [Agent harness](openspec/specs/agent-harness/spec.md) owns the bounded loop,
  closed tool registry, workspace policy, and read-tool contracts.
- [CLI chat](openspec/specs/cli-chat/spec.md) owns the current `yo` entrypoint,
  in-memory conversation, input ownership, and per-turn recovery.
- [Codex authentication and transport](openspec/specs/codex-auth-transport/spec.md)
  owns trusted OAuth, credential handling, provider conversion, and confirmed
  answer delivery.
- [Approval-gated patching](openspec/specs/approval-gated-patching/spec.md) owns
  exact proposals, full-diff consent, revalidation, and atomic application.
- [Run observation](openspec/specs/run-observation/spec.md) owns retained runs,
  live events/results, and between-turn `/runs` and `/run N` inspection.
- [Allowlisted validation proposal](openspec/changes/allowlisted-validation/proposal.md)
  is an unapproved later draft for exactly `test` and `build`.

Current state and the next planning boundary are indexed from
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

## Current planning boundary

The implemented harness, ephemeral chat, exact approval-gated patches, and
run observation are complete. The sole agent entrypoint is `yo`; OAuth commands
remain separate trusted CLI operations. Current requirements live exclusively
in `openspec/specs/`; changes use `openspec/changes/`. See the
[development workflow](CONTRIBUTING.md).

The [cancellation change](openspec/changes/archive/2026-10-02-cancel-active-runs/proposal.md)
is implemented, verified, accepted, and synchronized into the current specs. It
propagates trusted cancellation through model/tool/review work, waits for cleanup,
retains every accepted call result, and permits inspection and a fresh turn.
Applied patches and committed completion remain intact. The user authorized
implementation with a commit after each step and accepted the result on 2026-10-02.
See [verification](openspec/changes/archive/2026-10-02-cancel-active-runs/verification.md)
for the 466-test full check, real PTY/process-signal evidence, and coverage limits.
The [explicit rerun proposal](openspec/changes/archive/2026-10-03-rerun-settled-runs/proposal.md),
[design](openspec/changes/archive/2026-10-03-rerun-settled-runs/design.md),
[deltas](openspec/changes/archive/2026-10-03-rerun-settled-runs/specs/), and
[tasks](openspec/changes/archive/2026-10-03-rerun-settled-runs/tasks.md) are archived.
Implemented `/rerun N` repeats a settled source's exact task in the current
conversation and workspace with fresh budgets, cancellation, and patch consent.
Arrival-window receipts suppress buffered duplicates; later fresh prompts permit
another attempt. Safe direct source linkage and original evidence are retained.
[Final evidence](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md#task-53-final-regression-and-requirement-review)
records the 568-test full suite, integrated demonstration, real local PTY with a
faux provider, and coverage limits. [Task 6.1](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md#task-61-standing-human-approval-and-accepted-scope)
records the exact standing human approval for every bounded rerun task, including
verified closure, with one subagent and commit per task; it claims no separate
later acceptance reply or personal human review of completed checks.
[Specification synchronization](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md#task-62-verified-specification-synchronization)
and [archive closure](openspec/changes/archive/2026-10-03-rerun-settled-runs/verification.md#task-63-archive-and-project-map-closure)
are complete. See [usage](CONTRIBUTING.md#chat-commands-and-rerun).

The [validation draft](openspec/changes/allowlisted-validation/proposal.md),
[design](openspec/changes/allowlisted-validation/design.md), and
[tasks](openspec/changes/allowlisted-validation/tasks.md) remain unapproved.
The next planning candidate is to rebase and review this draft against the
verified cancellation/rerun contracts before proposing an implementation leaf.
Its stale CLI delta currently fails the global specification check; current specs
pass strict validation. Neither draft completeness nor rerun approval authorizes
validation or process execution.
Old milestone requirements and plans have been removed; the OpenSpec archive
retains the completed [inspection change evidence](openspec/changes/archive/2026-10-02-inspect-settled-runs/verification.md).

## Later direction

After separate planning and approval, later milestones may:

1. Rebase and review the unapproved Milestone 5 allowlisted-validation draft,
   then confirm a bounded implementation leaf before adding test/build execution
   and evidence in event feeds and result cards.
2. Consider append-only JSONL session history, richer terminal presentation,
   skills/extensions, and provider portability after the in-memory execution
   interface and its control boundaries have been validated.
