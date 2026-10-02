# Design

## Context

**Unapproved imported draft.** See [proposal](proposal.md) for motivation and
scope. This migration adds no runtime behavior. Cancellation and explicit rerun
are prerequisite projects, not capabilities supplied by this change. Before
implementation, rebase these deltas against their completed specifications and
confirm the validation permission model and the first bounded leaf.

The currently implemented runtime has these relevant properties:

- `ToolCall.name` is an open string and `arguments` is `unknown` until the
  dispatcher performs closed lookup and strict Zod validation;
- model-visible `ToolName`, the loop's visible-tools list, the provider tool
  definitions, and the system prompt expose `list_files`, `search_code`,
  `read_file`, and `propose_patch`;
- the generic read-tool registry authorizes paths and uses a detached
  `Promise.race` timeout;
- the specialized patch path avoids that generic timeout for mutation and uses
  abort-and-settle application semantics;
- the agent loop executes tool calls sequentially, records one result per call,
  and continues within a fixed model-step budget;
- the CLI retains session-local observation records and supports `/runs` and
  `/run N`; terminal summaries are bounded and raw tool results are not streamed;
- evidence records authorized tools, files, and patch outcomes;
- the CLI default per-tool timeout is five seconds, which is intentionally
  suitable for bounded reads but too short for repository tests and builds;
- no process executor, command catalog, validation schema, validation metadata,
  or process-tree cleanup exists;
- child-process code is absent from the model-visible runtime boundary.

### Target execution flow

`yo` uses the provider-neutral validation flow:

1. The model requests `run_validation` with `{ command: 'test' | 'build' }`.
2. The dispatcher rejects missing, extra, or unknown fields before process
   preparation.
3. Trusted code selects the exact npm executable and fixed argv.
4. The executor creates temporary home and cache state, constructs a minimal
   environment, and spawns npm with the approved workspace root as `cwd`, no
   stdin, and piped output.
5. An incremental accumulator decodes, sanitizes, and bounds combined stdout
   and stderr while retaining useful diagnostic tail output.
6. Exit `0`, non-zero exit, timeout, abort, or infrastructure failure maps to
   one structured result with safe validation metadata.
7. Timeout or abort terminates the harness-owned process tree and waits for
   settlement before returning.
8. Existing events, terminal status, evidence, transcript, and final-answer
   flow carry the result once.

```mermaid
sequenceDiagram
    participant Model
    participant Loop as Agent loop
    participant Dispatch as Validation dispatcher
    participant Catalog as Fixed command catalog
    participant Exec as Process executor
    participant Npm as npm script

    Model->>Loop: run_validation({ command })
    Loop->>Dispatch: untrusted ToolCall
    Dispatch->>Dispatch: strict Zod safeParse
    alt invalid or unknown
        Dispatch-->>Loop: one invalid result
    else test or build
        Dispatch->>Catalog: resolve identifier
        Catalog-->>Dispatch: fixed executable and argv
        Dispatch->>Exec: canonical cwd, fixed timeout
        Exec->>Npm: spawn without stdin
        Npm-->>Exec: stdout, stderr, exit
        alt timeout or abort
            Exec->>Npm: terminate process tree
            Npm-->>Exec: settled
        end
        Exec-->>Dispatch: bounded structured outcome
        Dispatch-->>Loop: one ToolResult
    end
    Loop-->>Model: validation observation
```

## Goals / Non-Goals

Preserve the current loop, transcript, observation, and explicit patch-consent
owners while adding a narrowly bounded process executor. Select `test` or
`build` through a fixed catalog rather than model text evaluated by a shell.
The complete behavioral contract is in [the validation delta](specs/allowlisted-validation/spec.md).

No general executor API, configurable timeout, per-call approval UX, persistent
logs, live process-output UI, or automatic validation loop is introduced. npm
script bodies remain trusted repository code; environment minimization cannot
provide filesystem or network isolation.

## Decisions

### Validation contracts and catalog

Add a dedicated internal module for:

- `ValidationCommand = 'test' | 'build'`;
- strict `runValidationArgumentsSchema`;
- immutable command descriptors;
- fixed validation timeout and output limits;
- validation outcome and metadata types;
- pure result-formatting helpers.

The catalog contains no model-controlled values:

```ts
type ValidationCommandDefinition = Readonly<{
    command: ValidationCommand
    displayCommand: 'npm test' | 'npm run build'
    executable: string
    arguments: readonly string[]
}>
```

The platform-specific npm executable is selected inside trusted code. Catalog
lookups use explicit exhaustive branching or a `satisfies`-checked record.

The schema is public only when the provider activates the completed tool. Raw
spawn functions, environment construction, termination, and process
operations remain internal and absent from the runtime barrel.

### Incremental output accumulator

Create a pure, independently tested accumulator that:

- accepts decoded stdout/stderr chunks in callback arrival order;
- strips ANSI and unsafe terminal control sequences;
- normalizes carriage returns and malformed UTF-8;
- tracks observed UTF-8 bytes and logical lines;
- retains only the newest complete diagnostic tail within 50 KiB and 2,000
  lines;
- emits existing truncation metadata without retaining unbounded prior output;
- produces deterministic empty-output and final-newline behavior.

This component has no process or filesystem access. Focused tests cover
multi-byte boundaries, chunk-split ANSI sequences, very long lines, both
limits, mixed stdout/stderr, malformed bytes, and exact boundary cases.

### Process executor

Create an internal validation executor with injected operations for
deterministic tests. Production operations use Node child-process APIs with:

- `shell: false` at the harness spawn layer;
- fixed canonical `cwd`;
- `stdio: ['ignore', 'pipe', 'pipe']`;
- an internally selected npm executable and fixed argv;
- a minimal environment and per-call temporary home/cache directories;
- a fixed 120-second validation timeout;
- process-tree termination on timeout or abort;
- settle-before-return and temporary-state cleanup.

npm will interpret the selected package script through its platform script
shell. This is expected repository behavior and is why the workspace must be
trusted. No model string enters that shell.

The executor returns a provider-neutral internal outcome. It does not construct
`ToolResult` directly and does not know about model steps, terminal rendering,
or evidence reports.

Use the relevant mechanics from `pi`'s bash execution as a reference:

- streamed child stdout/stderr capture;
- abort signalling;
- process-tree termination;
- waiting for child settlement;
- bounded sanitized output.

Do not copy `pi`'s broad contract:

- no free-form command string;
- no model-selected timeout;
- no configurable shell;
- no command prefix or spawn hook;
- no environment override;
- no remote executor;
- no live terminal streaming;
- no persistent full-output log;
- no background execution.

### Dispatcher integration

Add a specialized `run_validation` dispatch path rather than placing a child
process inside the existing generic read-tool `Promise.race`.

The path owns:

```text
strict validation
    -> allowlist decision
    -> abort-and-settle executor
    -> safe ToolResult mapping
```

Invalid arguments produce no allow decision and start no process. Accepted
identifiers emit one `allow` decision. The fixed catalog is the permission
policy; there is no approval callback.

Map outcomes as defined by the requirements and retain bounded partial output
for non-zero exit, timeout, and abort. Unknown or raw external errors are
sanitized with local Zod `safeParse` when their shape must be inspected.

Add an optional injected validation executor to dispatcher and agent-loop
options for tests. Production composition uses the internal executor by
default. Do not expose the executor from `src/runtime/index.ts`.

### Agent loop and conversation

Thread the validation dispatch option through `runAgent` and
`runConversationTurn` without changing transcript ownership or conversation
retention semantics.

No validation-specific control loop is added. The existing model-step budget
remains authoritative:

- the model decides whether `test`, `build`, both, or neither is useful;
- calls in one model response execute sequentially under current semantics;
- the harness does not automatically run validation after a patch;
- the harness does not retry, repair, or reorder validation calls.

The system prompt should advise the model to request one validation at a time
when the next action depends on its result.

### Tool result metadata and events

Extend result metadata with an optional validation block so existing tool
results remain structurally compatible. Use narrow types rather than
unstructured records.

The existing `tool_requested`, `tool_authorized`, and `tool_completed` events
are sufficient. Do not add redundant validation lifecycle events unless
implementation proves that a required state cannot be represented.

Snapshots remain detached and structurally read-only. Safe validation metadata
contains only command identifier, display command, outcome, exit code, and
truncation. It excludes environment, temporary paths, process identifiers, raw
spawn options, and unsafe error objects.

### Terminal renderer and evidence

Teach the terminal renderer to summarize only the strict command enum:

```text
tool=run_validation command="test"
```

Invalid arguments display `arguments=unavailable`. ANSI or child output never
enters the one-line status path.

Teach evidence reporting to collect validation outcomes from completed tool
results:

```text
Validations:
- test: passed
- build: failed (exit 2)
```

Keep call order, deduplicate only identical repeated evidence if the current
report policy requires it, and never infer that an unrequested validation
passed.

The CLI does not add a new command, flag, prompt, or live process-output panel.
`yo` uses the existing terminal renderer, observation feed/result card, and
evidence report.

Extend the observation projection with validation identifier, structured
outcome, exit code when available, and bounded sanitized diagnostics. Keep
failed tests distinct from executor failure, render each call once, and use
only confirming tool results for pass claims.

### Provider adapter and system prompt

Activate the model-visible capability only after contracts, executor,
dispatcher, cancellation, terminal, and evidence paths are tested.

In one bounded activation leaf:

- add `run_validation` to `ToolName`;
- add it to the agent loop's visible-tools list;
- add the strict provider JSON schema derived from the approved contract;
- update provider-definition parity tests;
- update the system prompt to describe the two identifiers and evidence rule;
- update runtime barrel tests without exporting raw process operations.

Prompt guidance does not enforce safety. The closed schema, catalog, executor,
and dispatcher remain authoritative.

### CLI and end-to-end compatibility

Use faux model transports and injected validation execution for deterministic
CLI tests. Cover:

- `yo`: read, approved patch, `test`, final evidence, then a follow-up turn;
- `test` pass and failure;
- `build` pass and failure;
- timeout and abort;
- renderer failure not changing transcript or duplicating results;
- no approval prompt for validation;
- no validation input entering the user transcript;
- workspace root unchanged by deterministic fake validation.

Add one controlled real-process test in a temporary fixture whose
`package.json` contains harmless `test` and `build` scripts. The fixture must
prove:

- the exact script is selected;
- pre/post lifecycle hooks do not run;
- stdin is unavailable;
- ambient sentinel secrets are absent;
- stdout/stderr are captured;
- non-zero exit and truncation are reported;
- timeout cleanup settles.

Normal automated tests do not use real OAuth, network, home credentials, or the
project checkout as an execution target.

### Alternatives and rationale

- A generic shell tool would expose commands and arguments beyond the selected
  scope; use the two-entry immutable catalog.
- A generic read-tool timeout can return while a process keeps running; use a
  dedicated executor that signals termination and waits for settlement.
- Full environment inheritance exposes ambient secrets; build a minimal child
  environment with per-call temporary home/cache.
- Collecting all output then truncating allows unbounded memory; accumulate a
  bounded sanitized diagnostic tail incrementally.
- Automatic post-patch validation would couple two permissions; keep the model's
  explicit validation call distinct from exact patch approval.

The reference is [pi's bash execution](../../../../pi/packages/coding-agent/src/core/tools/bash.ts):
reuse streamed capture, abort signals, tree termination, and settlement mechanics,
while keeping free-form commands, configurable shells, hooks, and remote execution
outside yo's scope.

## Risks / Trade-offs

### Trusted script body is broader than a command identifier

The enum constrains the model, but `package.json` script bodies remain arbitrary
repository code.

Mitigate with explicit trusted-workspace documentation, minimal environment,
offline npm, disabled pre/post hooks, no stdin, and no claim of sandboxing.
Real isolation remains deferred.

### Generic timeout leaves a process alive

The current dispatcher race bounds waiting but does not cancel work.

Use a validation-specific abort-and-settle executor, terminate the process
tree, drain or close streams, wait, clean temporary state, and then return one
timeout or abort result.

### Five-second read timeout is unsuitable

Changing the existing budget would alter read and patch behavior.

Use one internal fixed validation timeout of 120 seconds. Do not add
configuration in this milestone. Record timeout distinctly in the result.

### Output is hostile or enormous

Scripts may print ANSI controls, binary data, secrets, or unlimited logs.

Use a bounded incremental sanitizer, no direct streaming, minimal environment,
safe deterministic summaries, and explicit truncation metadata. The trusted-
workspace assumption remains necessary because output sanitization cannot
prove arbitrary repository code is secret-free.

### Platform process semantics drift

npm executable naming and descendant termination differ on POSIX and Windows.

Keep platform selection internal, inject operations for deterministic contract
tests, add platform-gated real-process coverage, and fail with a sanitized
execution result rather than falling back to a shell command.

### Capability activates too early

Provider visibility could let the model request an incompletely controlled
process.

Keep `ToolName`, visible-tools, provider definitions, and prompt unchanged
until the activation leaf after executor and dispatcher tests pass.

## Migration Plan

No deployment or runtime migration occurs during this documentation move.
Implementation starts only after the prerequisite review gate in [tasks](tasks.md).
Build pure contracts/output bounds first, then the internal executor, dispatcher,
and integration. Activate provider visibility only after enforcement passes.
Before activation the four-tool registry stays unchanged. If activation must be
reverted, remove validation visibility and routing together; do not attempt to
undo files already changed by trusted repository scripts. No persistent validation
state or data migration is planned.

### Validation

Each implementation leaf runs:

1. its focused Node test file;
2. any directly affected compatibility tests;
3. `npm test`;
4. `npm run build`;
5. `npm run format:check`;
6. `npm run spec:check` and `git diff --check`.

Documentation-only preparation runs targeted Markdown/link/checklist checks,
Prettier validation, and `git diff --check`; it does not require runtime tests.

The milestone closes only after:

- every leaf passes its scoped checks and review;
- full automated checks pass;
- controlled real-process coverage passes;
- the final diff contains only intended files;
- one manually reviewed ChatGPT Plus-backed temporary-workspace flow confirms
  patch approval, selected validation, accurate output, and evidence;
- only implemented and verified deltas are synchronized to main specs, the
  change is archived, and project maps are updated after result review.
