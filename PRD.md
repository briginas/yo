# PRD: Read-only CLI Coding-Agent Harness

This file is the stable product map. Read the linked milestone requirements only
when the task concerns that milestone.

## Objective

Build a small TypeScript command-line coding agent for learning how an agent
harness works. Given a task and an approved workspace, the agent may inspect
repository files and return an evidence-backed answer or plan.

The project takes architectural inspiration from [`pi`](../pi): a model invokes
typed tools through a controlled loop, and the harness validates, executes,
records, and returns observations. `yo` deliberately implements smaller,
independently verifiable slices of that design.

## Stable harness behavior

### Agent loop

1. Parse the CLI task and canonicalize `--cwd` as the sole allowed workspace
   root.
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
- Tools are read-only. The registry exposes no write, process, shell, network,
  credential, or connector capability.
- OAuth and model requests run only in trusted CLI infrastructure outside the
  model tool registry.
- The CLI may write only its OAuth credential store at `~/.yo/auth.json`; it
  must not write inside the approved workspace.
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

- `yo login` to complete browser OAuth through the OpenAI website;
- `yo auth status` to report non-secret authentication state;
- `yo logout` to remove the stored OAuth credential.

## Requirement map

- [Milestone 1: read-only `yo ask`](docs/requirements/milestone-1-read-only-ask.md)
  is complete. Read it for baseline behavior, regressions, or compatibility.
- [Milestone 2: in-memory interactive chat](docs/requirements/milestone-2-in-memory-chat.md)
  is complete. Read it for interactive-chat behavior, regressions, or
  compatibility.
- [Milestone 3: approval-gated patch application](docs/requirements/milestone-3-approval-gated-patches.md)
  requirements are approved. Read them when planning or implementing the
  workspace-mutation boundary.

Current milestone status and the next planning boundary are indexed from
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

## Next planning boundary

Milestone 3 may propose and apply patches behind explicit terminal approval.
Its requirements are approved and its
[active implementation plan](docs/plans/active/milestone-3-approval-gated-patches.md)
defines the bounded work. No runtime leaf has been approved or implemented, so
the current harness remains read-only.

## Later direction

After separate planning and approval, later milestones may:

1. Add allowlisted validation commands with fixed working directory, timeout,
   and output limits.
2. Add append-only JSONL sessions, then compaction that preserves task, approval
   state, changed files, and validation evidence.
3. Add richer interactive UX, then skills/extensions and provider portability
   after the in-memory chat loop has been validated.
