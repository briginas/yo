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

- [Agent harness](openspec/specs/agent-harness/spec.md) owns the bounded loop,
  closed tool registry, workspace policy, and read-tool contracts.
- [CLI chat](openspec/specs/cli-chat/spec.md) owns the current `yo` entrypoint,
  in-memory conversation, input ownership, and per-turn recovery.
- [Codex authentication and transport](openspec/specs/codex-auth-transport/spec.md)
  owns trusted OAuth, credential handling, provider conversion, and confirmed
  answer delivery.
- [Approval-gated patching](openspec/specs/approval-gated-patching/spec.md) owns
  exact proposals, full-diff consent, revalidation, and atomic application.
- [Run observation specification](openspec/specs/run-observation/spec.md) is
  the current requirement source for implemented leaves **10.1–10.3**: retained
  runs, live events/results, and between-turn `/runs` and `/run N` inspection.
  [Milestone 4 historical requirements](docs/requirements/milestone-4-run-observation.md)
  retain acceptance history and deferred work; milestone closure is complete.
- [Milestone 5: allowlisted validation](docs/requirements/milestone-5-allowlisted-validation.md)
  is drafted for later review. It proposes exactly `test` and `build`; no
  process implementation is authorized yet.

Current milestone status and the next planning boundary are indexed from
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

## Current planning boundary

Milestone 3 is complete. `yo` may propose one exact patch to an existing file,
but trusted terminal approval remains required before any workspace write. Its
[completed plan summary](docs/plans/completed/milestone-3-approval-gated-patches.md)
records deterministic and real OAuth-backed verification.

The public agent workflow is now chat-only. Authentication commands remain
separate trusted CLI operations.

Milestone 4 is complete through **10.4**:
[current specification](openspec/specs/run-observation/spec.md),
[historical requirements and deferred work](docs/requirements/milestone-4-run-observation.md), and
[completed implementation plan](docs/plans/completed/milestone-4-run-observation.md).

The user selected `/runs` and `/run N` and explicitly authorized 10.3 on
2026-10-02. Implementation passed deterministic checks and agent self-review;
[verification evidence](openspec/changes/archive/2026-10-02-inspect-settled-runs/verification.md)
records the scope and limitations. Inspection reads retained safe records
between turns without invoking the model, changing the conversation, sampling
run clocks, or granting patch consent. Earlier 10.1–10.2 acceptance and review
records remain in the completed plan. Physical TTY and live-provider behavior were
not newly verified. The user then authorized **10.4 first-version closure**
and a final commit. Closure passed 64 focused checks and all 341 project tests,
plus the repository checks and terminal-flow self-review. The OpenSpec change
is archived. The next planning boundary is cancellation, requiring its own
requirements and bounded implementation confirmation.

OpenSpec owns the current implemented requirements for the harness, chat,
authentication/transport, patches, and observation; see the
[development workflow](docs/openspec.md). Milestone 1–3 requirement files have
been removed after migration. Completed plans retain execution and verification
records, not a parallel current specification.

The selected follow-up order is cancellation, then explicit rerun, then
validation results. Cancellation and rerun each need a separate reviewed plan.
The existing Milestone 5 validation draft remains documentation-only:
[requirements](docs/requirements/milestone-5-allowlisted-validation.md) and
[draft implementation plan](docs/plans/active/milestone-5-allowlisted-validation.md).
It will add exactly `test` and `build` and show their results in the observation
interface after the preceding increments are verified.

## Later direction

After separate planning and approval, later milestones may:

1. Add run cancellation through a trusted controller that settles active work.
2. Add explicit rerun as a new linked run with a defined context policy and fresh
   patch approval.
3. Add Milestone 5 allowlisted validation and show test/build evidence in event
   feeds and result cards.
4. Consider append-only JSONL session history, richer terminal presentation,
   skills/extensions, and provider portability after the in-memory execution
   interface and its control boundaries have been validated.
