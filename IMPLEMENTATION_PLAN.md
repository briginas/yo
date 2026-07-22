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

- [x] **3. Safe read-only filesystem layer**
    - [x] **3.1 Build the base read-only filesystem layer**
        - [x] Canonicalize the approved workspace root.
        - [x] Resolve requested paths and enforce workspace, symlink, and sensitive-path permissions.
        - [x] Implement the `list_files` operation.
        - [x] Implement the `search_code` operation.
        - [x] Implement the `read_file` operation.
        - [x] Export the filesystem APIs and verify the basic read-only flow.
    - [x] **3.2 Bound filesystem outputs**
        - [x] Add default and hard caps: 500 list results, 100 search matches, 2,000 lines, and 50 KiB of UTF-8 text.
        - [x] Enforce safe defaults when `limit` is omitted and reject requested result limits above the hard caps.
        - [x] Return consistent truncation metadata compatible with `ToolResultMetadata` and `ToolResultTruncation`.
        - [x] Verify result, line, and byte truncation for `list_files`, `search_code`, and `read_file`, including exact-limit and multibyte UTF-8 cases.
    - [x] **3.3 Verify the complete filesystem boundary**
        - [x] Verify traversal, external symlink, and sensitive-path denial.
        - [x] Verify that the public runtime exports no write or process API.
        - [x] Run the full build and test suite, review the diff, and check it for whitespace errors.

- [ ] **4. Agent loop with faux transport**
    - [ ] **4.1 Build the base bounded agent loop**
        - [ ] **4.1.1 Define the model transport boundary**
            - [ ] Add provider-neutral `ModelTransport`, `ModelRequest`, and discriminated `ModelResponse` types.
            - [ ] Represent assistant tool calls in the session transcript.
            - [ ] Keep model-provided arguments unknown and accept unknown tool names at the transport boundary.
            - [ ] Verify the contracts with focused tests and a build.
        - [ ] **4.1.2 Dispatch read-only tool calls**
            - [ ] Register only `list_files`, `search_code`, and `read_file`.
            - [ ] Apply tool lookup, schema validation, filesystem permissions, execution, and result normalization in order.
            - [ ] Normalize success, invalid arguments, unknown tool, denial, and execution error results.
            - [ ] Verify each dispatcher outcome and the absence of write, process, and network tools.
        - [ ] **4.1.3 Implement the bounded model/tool loop**
            - [ ] Create the in-memory session and stable system and user messages.
            - [ ] Execute tool calls sequentially, append their results, and continue with the updated transcript.
            - [ ] Count each model request as one step and stop with `step_budget_exhausted` at `RunBudget.maxSteps`.
            - [ ] Verify final-answer, tool-result-follow-up, and step-budget flows with a faux transport.
        - [ ] **4.1.4 Verify and expose the base loop**
            - [ ] Export only the approved read-only runtime APIs.
            - [ ] Verify multiple tool-call ordering and final session state.
            - [ ] Run the full build and test suite, formatting check, and whitespace check.
    - [ ] **4.2 Apply `RunBudget.perToolTimeoutMs` at the tool-execution boundary and return exactly one `timeout` result when it expires.**
    - [ ] **4.3 Record `RunEvent` values and guarantee one `ToolResult` per request.**
    - [ ] **4.4 Cover the PRD scenarios without real API credentials.**

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
