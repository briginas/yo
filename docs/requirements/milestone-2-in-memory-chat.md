# Milestone 2 requirements: in-memory interactive chat

- **Status:** active, implementation not started
- **Source of truth for:** Milestone 2 scope and acceptance criteria
- **Related documents:** [product map](../../PRD.md),
  [active implementation plan](../plans/active/milestone-2-in-memory-chat.md)

Milestone 2 adds an in-memory multi-turn CLI command:

```text
yo chat --cwd <approved-workspace> [--model <name>]
```

The command reuses the existing ChatGPT OAuth transport, canonical workspace
root, bounded agent loop, structured events, evidence output, and the same three
read-only tools. User messages, assistant messages, tool calls, and tool results
remain available to later turns only while the `yo chat` process is running.

The terminal provides live, event-backed feedback during each turn:

- show a prompt when user input is expected;
- show that the harness is waiting while a model request is in flight;
- show each tool request and its lifecycle outcome: running, completed, denied,
  timed out, or failed;
- include only a safe summary of tool arguments, truncation, and completion
  status rather than dumping unrestricted tool results;
- stream provider-labeled final-answer text as it arrives and clearly mark the
  end and stop reason of each turn;
- use stable line-oriented output without terminal control sequences when
  output is not an interactive TTY.

Interactive status output is derived from harness lifecycle events and must not
expose hidden reasoning, OAuth credentials, authorization headers, raw provider
payloads, unsanitized errors, assistant commentary, or text that the provider
has not identified as a final answer. A transport that cannot safely identify
final-answer deltas before completion returns the complete answer without live
text streaming. Terminal rendering remains outside the provider adapter and
read-only tool dispatcher.

Whitespace-only input is a local no-op: it is not sent to the model or appended
to the transcript, and the CLI prompts again. A transport failure or step-budget
exhaustion ends only the current turn; after reporting its sanitized status and
evidence, the chat prompts for another turn. Workspace setup failure, input
failure, EOF, and the exact `/exit` command end the chat process.

Milestone 2 does not add persistent sessions, JSONL history, compaction,
branching, a TUI, model-visible write or process tools, patch application,
validation commands, skills, extensions, MCP, subagents, API-key fallback, or
provider portability. Exiting the process discards the chat transcript and must
not write inside the approved workspace.

## Acceptance criteria

- A user can run
  `yo chat --cwd <approved-workspace> [--model <name>]`, complete multiple
  turns, and ask a follow-up that relies on messages and tool observations from
  an earlier turn.
- The approved workspace root and selected model remain fixed for the lifetime
  of the chat process.
- Each user turn has a fresh bounded step count and tool timeout, plus its own
  ordered events, final status, stop reason, and evidence.
- While a turn is active, the terminal clearly shows when the harness is
  waiting for the model and when each tool is running, completed, denied, timed
  out, or failed.
- Tool status displays contain only bounded, safe summaries of known arguments,
  result status, and truncation; they never dump unrestricted tool results or
  unknown argument objects.
- Provider-labeled final-answer text streams as it arrives and appears exactly
  once; commentary and unlabeled text never enter the answer stream, while
  transports without safe text deltas still produce the complete final answer.
- Interactive TTY progress is cleaned up on every completion and failure path,
  while non-TTY output remains deterministic and contains no terminal control
  sequences.
- EOF and the exact `/exit` command end the chat cleanly; `/exit` is not sent to
  the model or appended to the conversation transcript.
- Whitespace-only input is ignored locally, and transport failure or step-budget
  exhaustion reports the turn outcome before returning to the prompt.
- Exiting the process discards all chat state, leaves the approved workspace
  unchanged, and creates no persistent transcript or chat-state file.
- Live output and retained context never expose hidden reasoning, OAuth
  credentials, authorization headers, raw provider payloads, or unsanitized
  errors.
- The model-visible registry remains limited to `list_files`, `search_code`, and
  `read_file`, with the existing schema validation, permission checks, output
  bounds, and one-`ToolResult`-per-call invariant.
- Existing `yo ask`, `yo login`, `yo auth status`, and `yo logout` behavior
  remains compatible.
- Deterministic faux-transport tests pass without real credentials or paid
  requests, and one real ChatGPT Plus chat completes a tool-using turn and a
  follow-up without `OPENAI_API_KEY`.
