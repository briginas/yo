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

- One OpenAI Codex transport using a configured tool-capable model and ChatGPT Plus OAuth.
- Trusted CLI authentication commands that sign in through the OpenAI website and persist only the resulting OAuth credential outside the approved workspace.
- A bounded model/tool loop with streaming model output where supported.
- Typed, schema-validated, read-only tools:
    - `list_files({ path, glob?, limit? })`
    - `search_code({ query, path?, glob?, limit? })`
    - `read_file({ path, startLine?, endLine? })`
- Structured run events and a concise final evidence report.
- Deterministic tests using a faux model transport.

### Out of scope

- Model-invoked file writes, patch application, shell or process execution, dependency installation, network tools, credential access, and environment-variable reads.
- API-key authentication and fallback from ChatGPT OAuth to separately billed OpenAI API usage.
- Interactive REPL or TUI, persistent agent sessions, branching, compaction, skills, extensions, MCP, multi-provider support, and subagents.
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
- OAuth and model requests run only in trusted CLI infrastructure outside the model tool registry.
- The CLI may write only its OAuth credential store at `~/.yo/auth.json`; it must not write inside the approved workspace.
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

The first provider adapter converts between these interfaces and OpenAI Codex tool calling authenticated through ChatGPT OAuth. A faux adapter implements the same boundary for tests.

The public CLI also exposes:

- `yo login` to complete browser OAuth through the OpenAI website;
- `yo auth status` to report non-secret authentication state;
- `yo logout` to remove the stored OAuth credential.

## 6. Test plan

Use fixture directories and a scripted faux model to test:

- a final response without tool use;
- `search_code` followed by `read_file`, then a grounded final answer;
- malformed arguments and unknown tool names;
- paths outside the approved workspace, including traversal attempts;
- an executor error, a timeout, and step-budget exhaustion;
- the invariant that each requested call yields exactly one `ToolResult`;
- result truncation metadata and an evidence report that names the used files/tools.

Use injected HTTP and temporary credential stores to test OAuth and the Codex adapter without real credentials or network requests. Cover PKCE and state validation, credential permissions and refresh, login status and logout, secret redaction, final-answer streaming, and tool-call normalization.

## 7. Milestone 1 acceptance criteria

- The CLI completes a read-only research task against a fixture repository.
- No model-invoked code path can write files, start a process, access credentials, or make arbitrary network requests in this milestone.
- The trusted CLI writes only `~/.yo/auth.json`, with restrictive permissions, for ChatGPT OAuth login and token refresh.
- All tool input is schema-validated and all filesystem access remains inside `--cwd`.
- The faux-model test suite passes without real provider credentials or paid API calls.
- A user with ChatGPT Plus can run `yo login` and complete one real read-only task without configuring an OpenAI API key.
- The final output gives enough evidence for a human to check the answer.

## 8. Next milestone boundary

Milestone 2 adds an in-memory multi-turn CLI command:

```text
yo chat --cwd <approved-workspace> [--model <name>]
```

The command reuses the existing ChatGPT OAuth transport, canonical workspace root, bounded agent loop, structured events, evidence output, and the same three read-only tools. User messages, assistant messages, tool calls, and tool results remain available to later turns only while the `yo chat` process is running.

The terminal provides live, event-backed feedback during each turn:

- show a prompt when user input is expected;
- show that the harness is waiting while a model request is in flight;
- show each tool request and its lifecycle outcome: running, completed, denied, timed out, or failed;
- include only a safe summary of tool arguments, truncation, and completion status rather than dumping unrestricted tool results;
- stream final-answer text and clearly mark the end and stop reason of each turn;
- use stable line-oriented output without terminal control sequences when output is not an interactive TTY.

Interactive status output is derived from harness lifecycle events and must not expose hidden reasoning, OAuth credentials, authorization headers, raw provider payloads, or unsanitized errors. Terminal rendering remains outside the provider adapter and read-only tool dispatcher.

Milestone 2 does not add persistent sessions, JSONL history, compaction, branching, a TUI, model-visible write or process tools, patch application, validation commands, skills, extensions, MCP, subagents, API-key fallback, or provider portability. Exiting the process discards the chat transcript and must not write inside the approved workspace.

### Milestone 2 acceptance criteria

- A user can run `yo chat --cwd <approved-workspace> [--model <name>]`, complete multiple turns, and ask a follow-up that relies on messages and tool observations from an earlier turn.
- The approved workspace root and selected model remain fixed for the lifetime of the chat process.
- Each user turn has a fresh bounded step count and tool timeout, plus its own ordered events, final status, stop reason, and evidence.
- While a turn is active, the terminal clearly shows when the harness is waiting for the model and when each tool is running, completed, denied, timed out, or failed.
- Tool status displays contain only bounded, safe summaries of known arguments, result status, and truncation; they never dump unrestricted tool results or unknown argument objects.
- Final-answer text streams when the transport supports it and appears exactly once; transports without text deltas still produce the complete final answer.
- Interactive TTY progress is cleaned up on every completion and failure path, while non-TTY output remains deterministic and contains no terminal control sequences.
- EOF and the exact `/exit` command end the chat cleanly; `/exit` is not sent to the model or appended to the conversation transcript.
- Exiting the process discards all chat state, leaves the approved workspace unchanged, and creates no persistent transcript or chat-state file.
- Live output and retained context never expose hidden reasoning, OAuth credentials, authorization headers, raw provider payloads, or unsanitized errors.
- The model-visible registry remains limited to `list_files`, `search_code`, and `read_file`, with the existing schema validation, permission checks, output bounds, and one-`ToolResult`-per-call invariant.
- Existing `yo ask`, `yo login`, `yo auth status`, and `yo logout` behavior remains compatible.
- Deterministic faux-transport tests pass without real credentials or paid requests, and one real ChatGPT Plus chat completes a tool-using turn and a follow-up without `OPENAI_API_KEY`.

Later milestones may:

1. Propose and apply patches behind explicit terminal approval.
2. Add allowlisted validation commands with fixed working directory, timeout, and output limits.
3. Add append-only JSONL sessions, then compaction that preserves task, approval state, changed files, and validation evidence.
4. Add richer interactive UX, then skills/extensions and provider portability after the in-memory chat loop has been validated.
