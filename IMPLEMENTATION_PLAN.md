# Implementation plan

Run and review the checks for each step before moving to the next one.

- [x] **1. Project foundation**
    - [x] Initialize the local Git repository and npm/TypeScript project.
    - [x] Add minimal `build`, `test`, and `dev` commands.
    - [x] Verify that an empty CLI builds and runs.

- [x] **2. Runtime contracts**
    - [x] Define runtime-independent types for run state, events, tool calls, and tool results.
    - [x] Add Zod schemas for future tool arguments.
    - [x] Verify types and basic unit tests for the contracts.

- [ ] **3. Safe read-only filesystem layer**
    - [x] **3.1 Build the base read-only filesystem layer**
        - [x] Canonicalize the approved workspace root.
        - [x] Resolve requested paths and enforce workspace, symlink, and sensitive-path permissions.
        - [x] Implement the `list_files` operation.
        - [x] Implement the `search_code` operation.
        - [x] Implement the `read_file` operation.
        - [x] Export the filesystem APIs and verify the basic read-only flow.
    - [ ] **3.2 Bound filesystem outputs**
        - [x] Add default and hard caps: 500 list results, 100 search matches, 2,000 lines, and 50 KiB of UTF-8 text.
        - [x] Enforce safe defaults when `limit` is omitted and reject requested result limits above the hard caps.
        - [ ] Return consistent truncation metadata compatible with `ToolResultMetadata` and `ToolResultTruncation`.
        - [ ] Verify result, line, and byte truncation for `list_files`, `search_code`, and `read_file`, including exact-limit and multibyte UTF-8 cases.
    - [ ] **3.3 Verify the complete filesystem boundary**
        - [ ] Verify traversal, external symlink, and sensitive-path denial.
        - [ ] Verify that the public runtime exports no write or process API.
        - [ ] Run the full build and test suite, review the diff, and check it for whitespace errors.

- [ ] **4. Agent loop with faux transport**
    - [ ] Implement the bounded model-to-tool-to-result loop.
    - [ ] Apply `RunBudget.perToolTimeoutMs` at the tool-execution boundary and return exactly one `timeout` result when it expires.
    - [ ] Record `RunEvent` values and guarantee one `ToolResult` per request.
    - [ ] Cover the PRD scenarios without real API credentials.

- [ ] **5. CLI and evidence report**
    - [ ] Implement `yo ask "<task>" --cwd <workspace> [--model <name>]`.
    - [ ] Print the final answer and evidence report: stop reason, files, and tools used.
    - [ ] Verify a fixture-repository run with the faux transport.

- [ ] **6. OpenAI adapter**
    - [ ] Connect the Responses API using `OPENAI_API_KEY`.
    - [ ] Default to `gpt-5.6-terra` with `reasoning.effort: medium`; allow `--model` to override it.
    - [ ] Stream final answer text only; exclude keys and hidden reasoning from logs.
    - [ ] Manually verify one real read-only run.

- [ ] **7. Milestone 1 verification**
    - [ ] Run the full build and test suite.
    - [ ] Check the implementation against every PRD acceptance criterion.
    - [ ] Record the boundary for the next milestone: in-memory `yo chat`, retaining read-only tools only.

## Permanent constraints

- No write, shell, process, network, credential, or connector tools.
- No persistent sessions, TUI, REPL, or configuration file in milestone 1.
- Do not mark a step complete until its scoped checks have passed and its result has been reviewed.
