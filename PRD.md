# PRD: Read-only CLI Coding-Agent Harness

This file is the stable product map. Read the linked milestone requirements only
when the task concerns that milestone.

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

- [Milestone 1: read-only `yo ask`](docs/requirements/milestone-1-read-only-ask.md)
  is complete and records the historical one-shot baseline; the command has
  since been retired. Read it for regressions or historical compatibility.
- [Milestone 2: in-memory interactive chat](docs/requirements/milestone-2-in-memory-chat.md)
  is complete. Read it for interactive-chat behavior, regressions, or
  compatibility.
- [Milestone 3: approval-gated patch application](docs/requirements/milestone-3-approval-gated-patches.md)
  requirements are approved. Read them when planning or implementing the
  workspace-mutation boundary.
- [Milestone 4: allowlisted validation](docs/requirements/milestone-4-allowlisted-validation.md)
  is drafted for review. It proposes exactly `test` and `build`; no process
  implementation is authorized yet.

Current milestone status and the next planning boundary are indexed from
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

## Current planning boundary

Milestone 3 is complete. `yo` may propose one exact patch to an existing file,
but trusted terminal approval remains required before any workspace write. Its
[completed plan summary](docs/plans/completed/milestone-3-approval-gated-patches.md)
records deterministic and real OAuth-backed verification.

The public agent workflow is now chat-only. Authentication commands remain
separate trusted CLI operations.

Milestone 4 is now drafted for review:
[requirements](docs/requirements/milestone-4-allowlisted-validation.md) and
[active implementation plan](docs/plans/active/milestone-4-allowlisted-validation.md).
Its proposed model-facing boundary is one `run_validation` tool with only
`test` and `build`. Review and approval are required before implementation.

## Later direction

After separate planning and approval, later milestones may:

1. Add append-only JSONL sessions, then compaction that preserves task, approval
   state, changed files, and validation evidence.
2. Add richer interactive UX, then skills/extensions and provider portability
   after the in-memory chat loop has been validated.
