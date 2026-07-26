# Active implementation plan: Milestone 3 approval-gated patches

- **Status:** active; no runtime leaf approved yet
- **Source of truth for:** Milestone 3 implementation order and completion state
- **Related documents:** [implementation map](../../../IMPLEMENTATION_PLAN.md),
  [approved requirements](../../requirements/milestone-3-approval-gated-patches.md),
  [product map](../../../PRD.md)

Read this document before proposing or implementing Milestone 3 work. Complete
and verify one numbered leaf before requesting approval for the next. A checked
parent item means all of its leaf acceptance criteria passed and the result was
reviewed; creating this plan does not check or authorize any runtime item.

## Goal

Add one narrow local mutation to `yo`: a model may submit an exact replacement
proposal for one existing regular UTF-8 file, while trusted harness code owns
schema validation, path policy, immutable preview generation, explicit terminal
approval, stale-source verification, and atomic application.

The milestone must preserve the central boundary:

```text
model proposes data
    -> harness validates and prepares
    -> user approves the exact complete diff
    -> harness revalidates and applies
    -> model receives one structured result
```

Milestone 3 is not a general editing, shell, validation, or autonomous coding
milestone. It introduces only the approved `propose_patch` workflow.

## Current behavior

The verified runtime is still read-only:

- `ToolName`, the agent loop's `VISIBLE_TOOLS`, the dispatcher registry, and
  the OpenAI Codex provider definitions contain only `list_files`,
  `search_code`, and `read_file`;
- `ToolCall.arguments` remains `unknown` until the dispatcher validates it with
  the selected strict Zod schema;
- the dispatcher performs workspace authorization before execution and each
  filesystem operation repeats path authorization internally;
- the agent loop executes multiple tool calls sequentially and records one
  `ToolResult` and one `tool_completed` event for every requested call;
- the generic dispatcher timeout is a `Promise.race`, which is acceptable for
  read operations but cannot safely wrap a write that might finish after a
  timeout result;
- `runAgent` and `runConversationTurn` have no approval callback;
- `yo chat` owns one persistent `LineInput`, while `yo ask` can run with or
  without terminal composition;
- the terminal renderer shows bounded tool status but has no full-diff or
  approval UI;
- the provider adapter converts only the three read-only schemas into Codex
  function tools;
- the system prompt identifies the agent as read-only;
- the workspace resolver follows existing paths through `realpath`, so a write
  target needs an additional lexical-path and `lstat` rule that rejects
  symlinks rather than merely authorizing their canonical target.

There is no patch schema, transform, proposal state, write executor, approval
port, patch lifecycle event, or workspace mutation.

## Target behavior

`yo ask` and `yo chat` share a provider-neutral patch workflow:

1. The model requests `propose_patch` with one path and 1–20 exact
   `oldText`/`newText` replacements.
2. The dispatcher rejects unknown properties and limit violations before path
   authorization.
3. A patch preparer authorizes one existing non-symlink regular file, reads at
   most 1 MiB of valid UTF-8 text, applies all matches against the same
   line-ending-normalized original, and rejects missing, duplicate,
   overlapping, binary, unchanged, or oversized results.
4. The harness creates an in-memory proposal with random identifier, base and
   next-content hashes, normalized edits, complete display diff, and complete
   unified patch.
5. An injected approval port receives only the immutable approval view needed
   by the terminal. Runtime events carry safe metadata, not source content or
   the full diff.
6. If the approval channel is absent, non-interactive, reaches EOF, fails, or
   returns anything other than explicit `y` or `yes`, the call resolves as
   denied without a write.
7. On approval, trusted code reauthorizes the lexical path, repeats `lstat`,
   re-reads the source, checks the base hash, recomputes the result, and verifies
   the approved next hash and diff.
8. The applier writes and flushes a unique same-directory temporary file,
   preserves the target mode, checks cancellation before rename, and atomically
   replaces the target.
9. The dispatcher returns exactly one success, denial, conflict, timeout,
   aborted, or sanitized failure result. The loop records ordered lifecycle
   evidence and continues normally.

```mermaid
sequenceDiagram
    participant Model
    participant Loop as Agent loop
    participant Dispatch as Patch dispatcher
    participant Prepare as Proposal preparer
    participant UI as Terminal approval port
    participant Apply as Trusted applier
    participant FS as Approved workspace

    Model->>Loop: propose_patch(arguments)
    Loop->>Dispatch: untrusted ToolCall
    Dispatch->>Prepare: validated replacements
    Prepare->>FS: authorize, lstat, read
    FS-->>Prepare: source bytes and mode
    Prepare-->>Dispatch: immutable proposal
    Dispatch->>UI: complete approval view
    alt denied, EOF, or unavailable
        UI-->>Dispatch: denied
        Dispatch-->>Loop: one denied ToolResult
    else explicitly approved
        UI-->>Dispatch: approved
        Dispatch->>Apply: approved proposal
        Apply->>FS: reauthorize, lstat, re-read
        alt source changed or unsafe
            FS-->>Apply: conflict or denial
            Apply-->>Dispatch: no mutation
        else proposal still exact
            Apply->>FS: temp write, flush, atomic rename
            Apply-->>Dispatch: applied
        end
        Dispatch-->>Loop: one structured ToolResult
    end
    Loop-->>Model: result observation
```

Human review is outside the normal execution timeout. Preparation and
application each have bounded timeout handling. The write path must not use the
current detached `Promise.race`: when cancellation fires during temporary-file
I/O, trusted code waits for that I/O to settle, checks the aborted signal, skips
rename, cleans up, and only then returns `timeout` or `aborted`.

## Component roles

### Patch contracts and limits

Own the strict proposal schema, approved constants, patch types, internal
outcomes, and safe approval view. Keep the model-facing arguments untrusted
until validation and use `type` declarations.

Planned constants:

```ts
const PATCH_MAX_EDITS = 20
const PATCH_MAX_ARGUMENT_BYTES = 50 * 1024
const PATCH_MAX_FILE_BYTES = 1024 * 1024
const PATCH_MAX_DIFF_BYTES = 50 * 1024
```

Argument-byte accounting uses UTF-8 bytes from every `oldText` and `newText`,
not JavaScript string length.

### Pure patch transform

Own deterministic text behavior without filesystem or approval access:

- strict UTF-8 text and NUL rejection;
- BOM extraction and restoration;
- LF normalization and dominant line-ending restoration;
- exact unique matching against one original;
- overlap detection and reverse-offset replacement;
- no-change rejection;
- display diff and unified patch generation;
- source, result, argument, and diff limits;
- base and next-content SHA-256 hashes.

Use the maintained `diff` package, as `pi` does, rather than creating a partial
diff algorithm. Adding it is the only planned production dependency change in
this milestone and must occur in the pure-transform leaf with focused tests and
a reviewed lockfile diff. `yo` must not copy `pi`'s fuzzy whitespace matching.

### Workspace write-target resolver

Build on the existing lexical containment and sensitive-path policy while
adding write-specific checks:

- require an existing lexical path inside the canonical workspace;
- walk each lexical component from the workspace root with `lstat` and reject
  symbolic links, including symlinked parent directories;
- require a regular file;
- canonicalize the regular file and repeat containment and sensitive checks;
- return canonical absolute path, canonical relative path, and source stats
  needed by preparation.

Proposal preparation and application both invoke this resolver. Application
does not trust the earlier decision.

### Proposal preparer

Combine the authorized target and pure transform into an immutable in-memory
prepared proposal. Generate a non-predictive proposal identifier. Keep
`nextContent` and the absolute path internal; expose to the approval port only
the identifier, canonical relative path, hashes, complete diff, patch, and safe
line-count metadata.

### Approval port

Define a provider-neutral callback:

```ts
type PatchApprovalDecision = 'approved' | 'denied' | 'aborted'

type PatchApprover = (request: PatchApprovalRequest) => Promise<PatchApprovalDecision>
```

The runtime default is fail-closed when no approver exists. The callback does
not receive a write function and cannot change the prepared proposal. It is an
injected user-decision boundary, not a model tool.

### Trusted applier

Own revalidation, stale-base conflict detection, temporary-file lifecycle,
mode preservation, flush/close, cancellation-before-rename, atomic replacement,
and cleanup. Inject narrow filesystem operations in tests; never use the user's
real repository as a mutation fixture.

The applier serializes calls per canonical target only if runtime execution can
reach the same file concurrently. The current loop is sequential, so a queue is
not required for the first implementation. Base-hash revalidation remains
mandatory because other processes can mutate the file.

### Dispatcher and agent loop

Keep generic read-tool registration unchanged. Add a specialized patch dispatch
path because its phases are:

```text
validate -> authorize/prepare with timeout
         -> await human approval without execution timeout
         -> revalidate/apply with timeout
         -> one result
```

The specialized path must preserve unknown-tool, invalid-argument,
permission-event, sanitized-error, call-ID, and one-result invariants.

Extend `RunAgentOptions` and conversation-turn options with an optional
`PatchApprover`. Add safe patch lifecycle events separately from path
authorization so an `allow` path decision is never mistaken for human consent.
Events must not contain `oldText`, `newText`, `nextContent`, or unrestricted
diff content.

### Terminal input and rendering

Use the existing `LineInput` abstraction for approval input so deterministic
tests need no real TTY. In chat, the current turn temporarily owns the same
line-input instance after the user's task line and before the next `yo>` prompt.
In ask mode, create and close an approval-capable line input only when terminal
I/O is fully configured.

Before prompting:

- clear active model/tool progress;
- write the canonical path and complete diff to the user-visible output;
- state that approval writes to the workspace;
- prompt `Apply this patch? [y/N]`.

Only a trimmed, case-insensitive `y` or `yes` approves. Non-interactive mode,
blank input, other input, EOF, and input failure deny. A process abort maps to
`aborted`. Approval input is never appended as a user conversation message.

### Provider adapter and system prompt

Add the strict `propose_patch` JSON schema to the provider definition table only
after the complete runtime and terminal denial paths exist. Then add
`propose_patch` to `ToolName` and the loop's visible registry in the same
bounded leaf so runtime and provider visibility cannot drift.

Update the system prompt from “read-only agent” to explain that repository
inspection remains read-only and the only proposed mutation is an
approval-gated exact patch. Prompt text is guidance; all enforcement remains in
code.

### Evidence and compatibility

Evidence reports may include the canonical affected path and final patch
outcome, but not the full file content or duplicate the approval diff. Existing
read-tool reports, final-answer composition, OAuth behavior, and chat transcript
semantics remain unchanged.

## Scope boundaries

### In scope

- One model-facing `propose_patch` tool.
- One existing, non-symlink, regular UTF-8 file per call.
- 1–20 exact non-overlapping replacements against one original version.
- Bounded complete diff and unified patch.
- In-memory proposal identity and SHA-256 hashes.
- Explicit one-time terminal approval, default deny, and non-TTY fail-closed
  behavior.
- Independent preparation and application timeouts that never leave a detached
  write.
- Reauthorization and stale-source conflict detection.
- Atomic same-directory replacement with BOM, line-ending, and mode
  preservation.
- Safe lifecycle events, terminal output, evidence, provider schema, and
  deterministic faux-transport coverage.
- One manually reviewed ChatGPT Plus verification after all automated checks.

### Deferred

- New files, full-file writes, delete, rename, move, chmod, and directories.
- Multi-file or transactional patch sets.
- Fuzzy, regex, semantic, AST, or language-server edits.
- Automatic test, lint, format, build, shell, process, or package-manager
  execution.
- Automatic repair loops or rollback.
- Persistent sessions, JSONL, compaction, pending approvals, crash recovery, or
  approval caching.
- Git commit, push, pull request, merge, deployment, or external communication.
- TUI, external editor, project configuration, skills, extensions, MCP,
  connectors, subagents, or background work.
- API-key fallback or provider portability.
- A general sandbox or cross-process transactional isolation.

## Safety and compatibility invariants

- The model can propose data but cannot call an unapproved write primitive.
- `ToolCall.name` remains a string and `arguments` remain `unknown` until the
  dispatcher selects and applies a strict schema.
- Unknown proposal properties and over-limit inputs fail before filesystem
  access.
- Preparation and application independently enforce lexical containment,
  canonical containment, sensitive-path denial, symlink denial, regular-file
  status, and size limits.
- Approval is tied to one proposal identifier, canonical relative path, base
  hash, next hash, and complete diff.
- Truncated or partial diffs are never approvable.
- The approval callback cannot alter internal `nextContent` or choose another
  path.
- Missing approval infrastructure and every ambiguous input fail closed.
- Human think time does not consume the tool execution timeout.
- Timeout or abort during temporary-file work cannot return while a later
  rename may still occur.
- Source mismatch after approval returns conflict and preserves the newer file.
- A failed write never exposes a partially written target.
- Temporary-file names are unique, created with exclusive semantics, kept in
  the target directory, and cleaned up on every settled failure path.
- Each requested call produces exactly one transcript result and one terminal
  `tool_completed` event.
- Path authorization and human approval are represented as separate lifecycle
  decisions.
- Events, evidence, status lines, and errors exclude hidden reasoning, OAuth
  credentials, headers, raw provider payloads, unknown arguments, and
  unrestricted source content.
- Existing read tools, OAuth commands, `yo ask`, in-memory chat, final-answer
  release, step budgets, and evidence remain compatible.
- Tests use temporary explicit workspaces and injected operations; they never
  mutate the project checkout or real credentials.

## Main risks and mitigations

### Approval accidentally authorizes different bytes

**Risk:** the model, user, or another process changes state between preview and
write.

**Mitigation:** immutable proposal data, source and result hashes, full-diff
approval, reauthorization, re-read, recomputation, and conflict on any mismatch.

### A timeout returns while a write continues

**Risk:** the current `Promise.race` dispatcher pattern can report timeout while
an un-cancelled filesystem promise later mutates state.

**Mitigation:** use a patch-specific abort-and-settle timeout. All mutation
before rename targets only the temporary file; check the signal after each
await and immediately before atomic rename.

### Symlink or path replacement bypasses policy

**Risk:** canonicalizing a symlink target can make an alias look eligible, or
the lexical entry can change during the approval interval.

**Mitigation:** lexical containment, component-by-component `lstat` symlink
denial, canonical containment, sensitive checks, and the full resolver repeated
immediately before application. Atomic rename targets the approved lexical
entry and never follows a target symlink during the final replacement.

### Diff preview is incomplete or misleading

**Risk:** truncation, line-ending conversion, BOM handling, or fuzzy matching
causes the displayed diff to differ from applied bytes.

**Mitigation:** reject oversized diffs, use exact matching, derive preview and
application from the same pure transform, preserve encoding details, and verify
the recomputed diff and next hash before rename.

### Approval input conflicts with chat input

**Risk:** multiple readline interfaces compete for stdin or the approval answer
enters the conversation transcript.

**Mitigation:** reuse the chat's single `LineInput` sequentially during the
active turn. Pass approval through a callback outside conversation messages and
resume the `yo>` loop only after the tool result resolves.

### Model-visible capability appears before enforcement

**Risk:** adding `ToolName` or the provider schema early lets the model request a
tool whose denial, approval, or application path is incomplete.

**Mitigation:** build and test internal contracts, preparation, approval,
application, dispatcher, and CLI first. Activate provider visibility and update
the system prompt in a later leaf.

### Dependency broadens the project unexpectedly

**Risk:** diff generation adds supply-chain and bundle surface.

**Mitigation:** add only the maintained `diff` runtime package used by `pi`,
review the exact lockfile change, bundle it normally, and add no other
dependency.

## Implementation steps

- [ ] **9.1 Define patch proposal contracts and limits**

    - [ ] Add strict Zod schemas for one path and 1–20 exact replacement objects,
          rejecting unknown properties, empty `oldText`, and aggregate UTF-8
          argument size above 50 KiB.
    - [ ] Add named 1 MiB source/result and 50 KiB diff limits.
    - [ ] Define internal patch edit, approval-view, decision, conflict, and
          outcome types with `type` declarations.
    - [ ] Keep `ToolName`, `VISIBLE_TOOLS`, dispatcher registry, provider
          definitions, runtime barrel, and system prompt unchanged.
    - [ ] Add focused schema/limit tests for exact boundaries, next
          byte/edit/property rejection, multibyte UTF-8, and `arguments: unknown`.

    **Leaf acceptance:** contracts compile and focused tests pass; the model still
    sees only the three read tools and no code can write a workspace file.

- [ ] **9.2 Implement the pure exact-replacement and diff engine**

    - [ ] Add the maintained `diff` runtime dependency and review the lockfile
          change.
    - [ ] Decode UTF-8 fatally, reject NUL, split and restore BOM, normalize line
          endings for matching, and preserve the original dominant ending.
    - [ ] Match all replacements against one original, require exactly one match,
          reject overlaps, apply in reverse offset order, and reject unchanged
          output.
    - [ ] Generate deterministic display and unified diffs with canonical relative
          path labels; reject a diff beyond 50 KiB instead of truncating it.
    - [ ] Generate base and next-content SHA-256 hashes.
    - [ ] Add pure tests for multiple disjoint edits, duplicate/missing/overlap,
          BOM, LF/CRLF, Unicode bytes, binary content, no-op, file/result/diff
          boundaries, and deterministic hashes.

    **Leaf acceptance:** a filesystem-free function converts approved bytes plus
    validated edits into an exact bounded result; no dispatcher, loop, provider,
    CLI, or write behavior changes.

- [ ] **9.3 Prepare immutable proposals through a read-only write-target policy**

    - [ ] Add a write-target resolver that rejects lexical escapes, sensitive
          paths, symlinks in any path component, missing paths, directories,
          devices, sockets, and other non-regular files.
    - [ ] Repeat canonical containment and sensitive checks after `realpath`.
    - [ ] Read bounded source bytes and mode through injected narrow operations.
    - [ ] Build an immutable prepared proposal with random identifier, canonical
          relative path, hashes, complete diff/patch, internal next content, and
          safe approval metadata.
    - [ ] Add temporary-workspace tests for traversal, absolute escape, sensitive
          names, internal/external symlinks, non-regular paths, size limits, mode,
          and proposal immutability.

    **Leaf acceptance:** trusted code can prepare but not apply a proposal; all
    tests confirm the target workspace remains byte-for-byte unchanged.

- [ ] **9.4 Add the approval port and safe lifecycle vocabulary**

    - [ ] Define optional `PatchApprover` injection with
          `approved`/`denied`/`aborted` decisions and fail-closed absence.
    - [ ] Define patch-prepared, approval-requested, approval-resolved, conflict,
          and applied event metadata without source content or full diffs.
    - [ ] Verify event snapshots are cloned/frozen and an observer cannot mutate
          proposal state.
    - [ ] Add controlled callback tests for approval, denial, absence, abort,
          throw/failure sanitization, and no persistence.
    - [ ] Do not add the patch tool to the dispatcher or model-visible registry.

    **Leaf acceptance:** approval and observability contracts exist independently
    of terminal code and mutation; the runtime still exposes only read tools.

- [ ] **9.5 Implement the guarded atomic applier**

    - [ ] Re-run write-target authorization, `lstat`, bounded read, base-hash
          comparison, pure transform, next-hash comparison, and diff comparison.
    - [ ] Return a machine-readable conflict without writing when any approved
          base/result property differs.
    - [ ] Create a unique exclusive temporary file in the target directory,
          preserve the approved mode, write, flush, close, check cancellation, and
          atomically rename.
    - [ ] Use patch-specific abort-and-settle timeout behavior; never let a timeout
          result race a later target rename.
    - [ ] Clean up settled temporary-file failures and sanitize filesystem errors.
    - [ ] Add injected-operation and temporary-workspace tests for success,
          stale source, path/symlink replacement, timeout at each await boundary,
          write/flush/close/rename failures, mode/BOM/line-ending preservation,
          target atomicity, and cleanup.

    **Leaf acceptance:** only a directly invoked internal applier with an approved
    proposal can mutate a temporary test workspace; every non-success path leaves
    the target unchanged.

- [ ] **9.6 Integrate `propose_patch` into the dispatcher behind approval**

    - [ ] Add a specialized patch dispatcher path with strict validation,
          preparation timeout, approval wait outside that timeout, application
          timeout, and exactly one result.
    - [ ] Keep generic read-tool registration behavior unchanged.
    - [ ] Map user denial, missing approver, conflict, timeout, abort, and sanitized
          failure to stable `ToolResult` statuses and error codes.
    - [ ] Emit path authorization and human approval as distinct decisions.
    - [ ] Add dispatcher tests for every result and event path, call-ID
          preservation, invalid-argument ordering, and no write after denial.
    - [ ] Keep the loop's visible tools and provider definitions unchanged.

    **Leaf acceptance:** controlled code can dispatch a patch call only when an
    approver is injected, but normal model requests still cannot see or request
    the tool.

- [ ] **9.7 Propagate approval through the agent loop and conversation**

    - [ ] Extend `RunAgentOptions`, internal dispatcher signature, and
          `RunConversationTurnOptions` with optional approval injection.
    - [ ] Record safe patch events in deterministic order while retaining one
          transcript result and one `tool_completed` event.
    - [ ] Verify sequential multiple calls, denial followed by model recovery,
          conflict followed by re-read/reproposal, step-budget behavior, transport
          failure, and observer isolation.
    - [ ] Preserve current callers by defaulting missing approval to denial.
    - [ ] Keep `propose_patch` absent from `VISIBLE_TOOLS`.

    **Leaf acceptance:** the loop can exercise the controlled dispatcher in tests
    without making the capability model-visible; existing read-only loop and
    conversation tests remain compatible.

- [ ] **9.8 Add terminal diff rendering and explicit approval input**

    - [ ] Add a terminal approval component that receives the immutable approval
          view, clears progress, renders the canonical path and complete diff, and
          prompts `Apply this patch? [y/N]`.
    - [ ] Reuse the active chat `LineInput` sequentially and keep approval text out
          of conversation messages.
    - [ ] Create and close approval input safely for `yo ask`.
    - [ ] Accept only trimmed case-insensitive `y`/`yes`; deny blank, other input,
          EOF, input failure, missing I/O, and non-interactive mode.
    - [ ] Keep TTY cleanup and deterministic non-TTY output behavior compatible.
    - [ ] Add renderer, line-input, and CLI dependency-injection tests without
          enabling the provider tool.

    **Leaf acceptance:** terminal approval is deterministic and fail-closed in
    isolation; no production model request advertises patching yet.

- [ ] **9.9 Activate the model-visible tool and compose CLI/provider behavior**

    - [ ] Add `propose_patch` to `ToolName`, `VISIBLE_TOOLS`, dispatcher registry,
          provider definition table, and safe terminal argument summaries in one
          reviewed change.
    - [ ] Update the system prompt to describe read-only inspection plus the sole
          approval-gated exact patch proposal.
    - [ ] Inject terminal approval into both `yo ask` and `yo chat`; missing or
          non-interactive approval remains denial, not an implicit write.
    - [ ] Extend evidence reporting with canonical affected path and outcome
          without duplicating full diff or source content.
    - [ ] Update the runtime export allowlist deliberately and verify no raw write
          operation becomes public.
    - [ ] Add provider conversion, CLI composition, faux-transport, safe-summary,
          and compatibility tests.

    **Leaf acceptance:** the model can request `propose_patch`, but every actual
    workspace mutation still requires the exact terminal approval flow; all
    existing commands and read tools remain compatible.

- [ ] **9.10 Verify and close Milestone 3**

    - [ ] Add a deterministic end-to-end faux scenario: inspect, propose, display,
          approve, apply, observe result, and return a final answer.
    - [ ] Cover denial, EOF, non-TTY, stale-source, timeout, abort, sensitive path,
          symlink, oversized diff, malformed arguments, and failure cleanup across
          the composed CLI.
    - [ ] Verify the approved workspace changes only at the approved path and only
          to the displayed next content.
    - [ ] Run the focused tests, `npm test`, `npm run build`,
          `npm run format:check`, and `git diff --check`.
    - [ ] Manually review the final diff and runtime public surface.
    - [ ] Complete one real ChatGPT Plus `yo chat` or `yo ask` run without
          `OPENAI_API_KEY`, inspect the full diff, deny one proposal, approve a
          second small proposal, and verify exact file bytes and evidence.
    - [ ] Mark Milestone 3 complete only after the real run and review, move this
          plan to `docs/plans/completed/`, and update the root maps.

    **Leaf acceptance:** every approved requirement has deterministic evidence,
    all project checks pass, the real approval flow is verified, and no deferred
    capability entered the runtime.

## Validation strategy

For each runtime leaf:

1. run the focused new or changed test file first;
2. inspect failures before changing adjacent components;
3. run `npm test`;
4. run `npm run build`;
5. run `npm run format:check`;
6. run `git diff --check`;
7. review the scoped diff and current public runtime surface;
8. update only the completed leaf checkbox after all checks pass.

Filesystem mutation tests use `mkdtemp` workspaces and explicit fixture paths.
They must assert both expected content and absence of unintended files.
Credential and provider tests remain isolated from real auth and network. The
real ChatGPT Plus verification occurs only in 9.10 after deterministic coverage
passes.

Documentation-only plan updates use link/checklist review,
`npm run format:check`, and `git diff --check`; they do not need runtime tests
when behavior is unchanged.

## Completion boundary

Milestone 3 is complete only when the model-visible proposal, exact full-diff
approval, guarded atomic application, structured result/event flow, CLI
composition, deterministic coverage, and one real ChatGPT Plus run all satisfy
the approved requirements.

The next milestone may plan allowlisted validation commands. Milestone 3 must
not implement or pre-design a general shell/process permission system while
closing this patch boundary.
