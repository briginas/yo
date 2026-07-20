# PRD: Read-only CLI Coding-Agent Harness

## 1. Objective

Build a small TypeScript command-line coding agent for learning how an agent harness works. Given a task and an approved workspace, the agent may inspect repository files and return an evidence-backed answer or plan.

The project takes architectural inspiration from [`pi`](../pi): a model invokes typed tools through a controlled loop, and the harness validates, executes, records, and returns observations. This milestone deliberately implements only the smallest safe slice of that design.

## 2. Users and success criteria

The primary user is a developer learning agent-harness design.

The milestone succeeds when a user can run one command against a small fixture repository and receive an answer that:

- identifies relevant files and, where applicable, line ranges;
- uses only the approved workspace;
- records which tools ran and why the run stopped;
- never writes files or executes shell commands.

## 3. Scope

### In scope

- A TypeScript CLI command:

  ```text
  yo ask "<task>" --cwd <approved-workspace>
  ```

- One OpenAI API transport using a configured tool-capable model.
- A bounded model/tool loop with streaming model output where supported.
- Typed, schema-validated, read-only tools:
  - `list_files({ path, glob?, limit? })`
  - `search_code({ query, path?, glob?, limit? })`
  - `read_file({ path, startLine?, endLine? })`
- Structured run events and a concise final evidence report.
- Deterministic tests using a faux model transport.

### Out of scope

- File writes, patch application, shell execution, dependency installation, network tools, and environment-variable reads.
- Interactive REPL or TUI, persistent sessions, branching, compaction, skills, extensions, MCP, multi-provider support, and subagents.
- Automatic retries beyond returning a structured failure to the model or caller.

## 4. Harness behavior

### Agent loop

1. Parse the CLI task and canonicalize `--cwd` as the sole allowed workspace root.
2. Build the model context from a stable system prompt, the user task, visible tool schemas, and prior structured observations.
3. Ask the model for either a final response or one or more tool calls.
4. For each tool call, validate the schema and evaluate the permission policy.
5. Execute allowed calls, cap their output, and append exactly one structured result per call.
6. Repeat until the model returns a final answer, the step budget is reached, the run is aborted, or an unrecoverable transport error occurs.

Every requested tool call receives a result: success, invalid arguments, unknown tool, denied access, timeout, execution error, or aborted. The model never directly accesses the filesystem.

### Permissions and bounds

- All tool paths must resolve inside `--cwd`; attempts to escape it are denied.
- Tools are read-only. The registry exposes no write, process, shell, network, credential, or connector capability.
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

## 5. Public interfaces

Keep the runtime independent of the CLI and OpenAI transport through these core concepts:

- `ToolDefinition`: name, description, input schema, risk class, executor, and result limits.
- `ToolCall`: model-requested tool name, identifier, and arguments.
- `ToolResult`: call identifier, status, content, metadata, and error details when relevant.
- `PermissionDecision`: `allow` or `deny`, with a machine-readable reason.
- `RunEvent`: an auditable lifecycle event emitted by the loop.
- `SessionState`: in-memory task, messages/observations, workspace root, budgets, and current run status.

The first provider adapter converts between these interfaces and OpenAI tool calling. A faux adapter implements the same boundary for tests.

## 6. Test plan

Use fixture directories and a scripted faux model to test:

- a final response without tool use;
- `search_code` followed by `read_file`, then a grounded final answer;
- malformed arguments and unknown tool names;
- paths outside the approved workspace, including traversal attempts;
- an executor error, a timeout, and step-budget exhaustion;
- the invariant that each requested call yields exactly one `ToolResult`;
- result truncation metadata and an evidence report that names the used files/tools.

## 7. Acceptance criteria

- The CLI completes a read-only research task against a fixture repository.
- No code path can write files or start a shell command in this milestone.
- All tool input is schema-validated and all filesystem access remains inside `--cwd`.
- The faux-model test suite passes without real provider credentials or paid API calls.
- The final output gives enough evidence for a human to check the answer.

## 8. Follow-up milestones

1. Propose and apply patches behind explicit terminal approval.
2. Add allowlisted validation commands with fixed working directory, timeout, and output limits.
3. Add append-only JSONL sessions, then compaction that preserves task, approval state, changed files, and validation evidence.
4. Add interactive UX, then skills/extensions and provider portability when the single-agent loop has been validated.
