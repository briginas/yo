# Milestone 4 active plan: allowlisted validation

- **Status:** draft; implementation not authorized
- **Prepared:** 2026-07-27
- **Requirements:** [Milestone 4 allowlisted validation](../../requirements/milestone-4-allowlisted-validation.md)
- **Previous milestone:** [Milestone 3 completed plan](../completed/milestone-3-approval-gated-patches.md)

Review and approve the requirements and this plan before implementation. After
approval, confirm exactly one incomplete leaf before editing runtime code.

## Goal

Add one narrow process capability to `yo`: the model may request either the
repository's `test` script or its `build` script through one strict
`run_validation` tool. Trusted harness code owns the fixed npm mapping,
workspace root, minimal environment, timeout, process-tree termination, bounded
output, structured result, observability, and provider exposure.

The milestone preserves this control boundary:

```text
model selects test | build
    -> harness validates the enum
    -> harness selects fixed executable and argv
    -> harness runs and settles the bounded process
    -> model receives one structured observation
```

It does not add a general shell. It also does not claim sandboxing: the selected
repository scripts are trusted local code running with the operating-system
permissions of `yo`.

## Current behavior

The verified Milestone 3 runtime has these relevant properties:

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
- terminal status output is one-line and bounded; tool result content is not
  streamed live;
- evidence records authorized tools, files, and patch outcomes;
- the CLI default per-tool timeout is five seconds, which is intentionally
  suitable for bounded reads but too short for repository tests and builds;
- no process executor, command catalog, validation schema, validation metadata,
  or process-tree cleanup exists;
- child-process code is absent from the model-visible runtime boundary.

## Target behavior

`yo ask` and `yo chat` share the same provider-neutral validation flow:

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

## Component design

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
rollback semantics.

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

The CLI does not add a new command, flag, prompt, or streaming panel. `yo ask`
and `yo chat` use the existing terminal renderer and evidence report.

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

- `ask`: read, approved patch, `test`, final evidence;
- `chat`: tool-backed validation followed by another turn;
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

## Scope boundaries

### Included

- `run_validation` with strict `test | build`.
- Fixed npm catalog and fixed workspace root.
- npm offline flags and lifecycle-hook suppression.
- Minimal environment and temporary home/cache.
- Bounded process execution, output, timeout, abort, and cleanup.
- Provider-neutral result metadata and existing operational events.
- Runtime, conversation, terminal, evidence, provider, prompt, and CLI
  integration.
- Deterministic and controlled real-process coverage.
- Documentation updates and one final reviewed real OAuth-backed flow.

### Excluded

- General shell, command text, arguments, selectors, paths, environment, or
  configurable timeouts.
- Any validation beyond test and build.
- Any package manager beyond npm.
- Dependency installation or network package access.
- Automatic validation, retry, repair, rollback, or ordering.
- Live process-output UI or persistent logs.
- Per-validation approval UX.
- Filesystem/network sandboxing and untrusted repositories.
- Session persistence, compaction, TUI, skills, MCP, connectors, subagents,
  provider portability, git operations, or deployment.

## Risks and mitigations

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

## Validation strategy

Each implementation leaf runs:

1. its focused Node test file;
2. any directly affected compatibility tests;
3. `npm test`;
4. `npm run build`;
5. `npm run format:check`;
6. `git diff --check`.

Documentation-only preparation runs targeted Markdown/link/checklist checks,
Prettier validation, and `git diff --check`; it does not require runtime tests.

The milestone closes only after:

- every leaf passes its scoped checks and review;
- full automated checks pass;
- controlled real-process coverage passes;
- the final diff contains only intended files;
- one manually reviewed ChatGPT Plus-backed temporary-workspace flow confirms
  patch approval, selected validation, accurate output, and evidence;
- requirements and plan move from draft to approved/completed state only after
  the corresponding review and verification.

## Implementation leaves

### 10.1 Validation contracts, catalog, and pure output bounds

- [ ] Add strict `test | build` contracts and constants.
- [ ] Add the immutable npm command catalog with lifecycle-hook suppression and
      offline flags.
- [ ] Add pure validation result formatting and incremental bounded-output
      accumulation.
- [ ] Add focused tests for schema rejection, catalog exactness, byte/line
      boundaries, ANSI/control sanitization, malformed UTF-8, and bounded
      memory behavior.
- [ ] Do not add child processes, dispatcher registration, public exports,
      provider definitions, prompt changes, or CLI behavior.

**Leaf acceptance:** pure contracts and accumulator tests pass; no process can
start and the model-visible registry is unchanged.

### 10.2 Abort-and-settle validation executor

- [ ] Add the internal executor and injected process-operation boundary.
- [ ] Add minimal environment and temporary home/cache preparation.
- [ ] Add no-stdin spawn, streamed capture, fixed timeout, process-tree
      termination, settle-before-return, and cleanup.
- [ ] Add focused deterministic tests for pass, non-zero exit, spawn failure,
      timeout, abort, late settlement, termination escalation, stream error,
      cleanup, environment isolation, and exact cwd/argv.
- [ ] Do not register or expose `run_validation`.

**Leaf acceptance:** executor tests prove bounded settled outcomes; model and
CLI behavior remain unchanged.

### 10.3 Closed dispatcher integration

- [ ] Add a specialized `run_validation` dispatcher branch with strict schema
      validation and fixed allowlist authorization.
- [ ] Map executor outcomes to one structured `ToolResult` with validation and
      truncation metadata.
- [ ] Preserve call IDs, safe errors, one permission decision, and one result.
- [ ] Add focused dispatcher tests for both commands, invalid inputs, failure,
      timeout, abort, and injected operation errors.
- [ ] Keep `ToolName`, visible-tools, provider definitions, and prompt
      unchanged.

**Leaf acceptance:** direct internal dispatch tests pass while the model still
cannot discover or request the tool through normal provider composition.

### 10.4 Agent-loop, conversation, terminal, and evidence propagation

- [ ] Thread injected validation execution through agent and conversation
      options for deterministic tests.
- [ ] Preserve ordered one-result transcript and event semantics.
- [ ] Add safe terminal argument summaries and completion status mapping.
- [ ] Add ordered validation outcomes to the evidence report.
- [ ] Cover multi-call order, failed validation continuation, chat rollback,
      renderer failure isolation, and exact evidence.
- [ ] Keep provider visibility disabled.

**Leaf acceptance:** internal faux calls propagate safely through all
provider-neutral and terminal layers without changing existing tool behavior.

### 10.5 Provider activation and prompt guidance

- [ ] Add `run_validation` to `ToolName` and the loop's visible-tools list.
- [ ] Add only the strict enum schema to the Codex provider definition table.
- [ ] Update provider parity and runtime barrel allowlist tests.
- [ ] Update the system prompt with the two validations, trusted-script
      boundary, accurate evidence rule, and one-at-a-time guidance.
- [ ] Export the schema and safe types only; do not export raw executor or
      process operations.

**Leaf acceptance:** provider, runtime, loop, and prompt agree on exactly one
new tool and two identifiers; malformed or broader calls still fail closed.

### 10.6 Deterministic CLI and controlled real-process coverage

- [ ] Add ask/chat faux-transport flows for test and build pass/failure.
- [ ] Add patch-then-validation evidence coverage without extra approval input.
- [ ] Add one controlled temporary npm fixture for exact script selection,
      lifecycle-hook suppression, environment isolation, output bounds,
      non-zero exit, timeout settlement, and cleanup.
- [ ] Verify normal automated tests use no real credentials, network, or user
      checkout mutation.
- [ ] Update README safety and usage orientation without duplicating detailed
      requirements.

**Leaf acceptance:** deterministic CLI and controlled process tests pass with
no capability beyond the approved enum.

### 10.7 Full verification and milestone closure

- [ ] Run focused tests, `npm test`, `npm run build`,
      `npm run format:check`, and `git diff --check`.
- [ ] Review the complete diff for scope, process safety, secret exposure,
      model-visible drift, and unrelated churn.
- [ ] Manually verify one ChatGPT Plus-backed flow in a disposable trusted
      workspace: inspect, approve a patch, run one selected validation, and
      report exact evidence.
- [ ] Record any platform limitation or skipped real verification explicitly.
- [ ] Mark requirements approved/completed only after review and move this plan
      to `docs/plans/completed/`.
- [ ] Update `PRD.md`, `IMPLEMENTATION_PLAN.md`, and README to the verified
      post-milestone state.

**Leaf acceptance:** all checks and review pass, real verification is recorded,
and the documentation no longer describes proposed behavior as current until
that evidence exists.

## First bounded candidate

After the user approves the requirements and this plan, the first candidate is
**10.1: validation contracts, fixed catalog, and pure bounded-output
accumulator**.

That leaf creates only typed data and pure transformations. It starts no
process, changes no provider-visible tool, and is independently verifiable
before the higher-risk executor work begins.
