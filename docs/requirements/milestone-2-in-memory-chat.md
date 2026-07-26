# Milestone 2 requirements: in-memory interactive chat

- **Status:** complete
- **Source of truth for:** Milestone 2 scope and acceptance criteria
- **Related documents:** [product map](../../PRD.md),
  [completed plan summary](../plans/completed/milestone-2-in-memory-chat.md)

Read this document when investigating interactive-chat behavior, regressions, or
compatibility with Milestone 2.

Milestone 2 added an in-memory multi-turn CLI command:

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
- release provider-confirmed final-answer text through the event observer after
  its output item is complete, and clearly mark the end and stop reason of each
  turn without duplicating the answer text in the evidence summary;
- use stable line-oriented output without terminal control sequences when
  output is not an interactive TTY.

**Transport boundary for safe final-answer delivery.** The `ModelTransport` call signature
is extended with an optional per-request `onFinalAnswerDelta` callback.
Streaming-aware transports invoke this callback with provider-confirmed
final-answer text after the provider completes and identifies its output item.
This is a safe delayed release, not byte-by-byte terminal streaming. Transports
that do not support safe delivery — including deterministic faux transports —
ignore the callback and produce the complete answer only at response time. The
runtime records each released delta as a lifecycle event observable by the
renderer; terminal rendering remains outside the provider adapter and the
read-only tool dispatcher.

**Provider-labeled output identity.** When a provider labels output items by
role (e.g. `message` with `output_text` content versus `reasoning`), the
transport must require the `output_index` carried by each `output_text.delta`
and correlate it with the `output_item.done` event carrying the same index. It
must buffer the delta until that completion event confirms the output item's
identity. Only deltas belonging to confirmed final-answer output items may be
emitted; deltas from reasoning, refusal, or unclassified items are silently
discarded. If the transport cannot correlate deltas with confirmed output
identity — due to malformed streams, missing `output_item.done` events, or
ambiguous output ordering — it must suppress all delayed delta releases and
fall back to the completed answer. This prevents commentary, hidden reasoning,
or unlabeled text from entering the answer stream through timing alone.

Interactive status output is derived from harness lifecycle events and must not
expose hidden reasoning, OAuth credentials, authorization headers, raw provider
payloads, unsanitized errors, or text that the provider has not identified as a
final answer. Terminal rendering remains outside the provider adapter and
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
- Provider-confirmed final-answer text is released through the event observer
  after its output item is complete and appears exactly once; commentary and
  unlabeled text never enter the answer stream, while transports without safe
  text deltas still produce the complete final answer.
- The per-turn evidence summary includes stop reason, tools used, and files
  inspected but does not repeat the final answer text; the answer appears only
  in the answer channel (released after confirmation or completed).
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
