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

- [x] **4. Agent loop with faux transport**
    - [x] **4.1 Build the base bounded agent loop**
        - [x] **4.1.1 Define the model transport boundary**
            - [x] Add provider-neutral `ModelTransport`, `ModelRequest`, and discriminated `ModelResponse` types.
            - [x] Represent assistant tool calls in the session transcript.
            - [x] Keep model-provided arguments unknown and accept unknown tool names at the transport boundary.
            - [x] Verify the contracts with focused tests and a build.
        - [x] **4.1.2 Dispatch read-only tool calls**
            - [x] Register only `list_files`, `search_code`, and `read_file`.
            - [x] Apply tool lookup, schema validation, filesystem permissions, execution, and result normalization in order.
            - [x] Normalize success, invalid arguments, unknown tool, denial, and execution error results.
            - [x] Verify each dispatcher outcome and the absence of write, process, and network tools.
        - [x] **4.1.3 Implement the bounded model/tool loop**
            - [x] Create the in-memory session and stable system and user messages.
            - [x] Execute tool calls sequentially, append their results, and continue with the updated transcript.
            - [x] Count each model request as one step and stop with `step_budget_exhausted` at `RunBudget.maxSteps`.
            - [x] Verify final-answer, tool-result-follow-up, and step-budget flows with a faux transport.
        - [x] **4.1.4 Verify and expose the base loop**
            - [x] Export only the approved read-only runtime APIs.
            - [x] Verify multiple tool-call ordering and final session state.
            - [x] Run the full build and test suite, formatting check, and whitespace check.
    - [x] **4.2 Apply `RunBudget.perToolTimeoutMs` at the tool-execution boundary and return exactly one `timeout` result when it expires.**
    - [x] **4.3 Record `RunEvent` values and guarantee one `ToolResult` per request.**
    - [x] **4.4 Cover the PRD scenarios without real API credentials.**

- [x] **5. CLI and evidence report**
    - [x] Implement `yo ask "<task>" --cwd <workspace> [--model <name>]`.
    - [x] Print the final answer and evidence report: stop reason, files, and tools used.
    - [x] Verify a fixture-repository run with the faux transport.

- [ ] **6. ChatGPT OAuth and OpenAI Codex adapter**
    - [x] **6.1 Store ChatGPT OAuth credentials safely**
        - [x] Define internal OAuth credential and credential-store contracts without changing the provider-neutral runtime boundary.
        - [x] Store the `openai-codex` credential in `~/.yo/auth.json`, with directory mode `0700`, file mode `0600`, atomic updates, and refresh locking.
        - [x] Verify create, read, update, delete, malformed-file, permission, and concurrent-refresh behavior using temporary paths.
    - [ ] **6.2 Implement browser login through OpenAI**
        - [x] Add `yo login` using PKCE S256 and a random state value; use the exact redirect URI `http://localhost:1455/auth/callback` and bind the temporary callback server only to `127.0.0.1:1455`.
        - [x] Print a clickable authorization URL without starting a browser process; reject callback state mismatches and report an occupied callback port clearly.
        - [x] Exchange the authorization code for an OAuth credential and persist it without logging token values or token responses.
        - [ ] Verify the complete login flow with injected HTTP and a temporary credential store; do not add device-code login.
    - [ ] **6.3 Implement the credential lifecycle**
        - [ ] Add `yo auth status` with non-secret account and expiry information and `yo logout` that removes the stored credential.
        - [ ] Refresh an expiring access token under the credential-store lock and persist a rotated refresh token before a model request.
        - [ ] Preserve the last stored credential on refresh failure, require a new `yo login`, and never fall back to an API key.
        - [ ] Verify status, logout, refresh success and failure, rotation, missing credentials, and secret redaction.
    - [ ] **6.4 Connect the OpenAI Codex Responses transport**
        - [ ] Send authenticated requests to the ChatGPT Codex Responses endpoint using the stored access token and account ID.
        - [ ] Convert provider-neutral messages, visible tool definitions, assistant tool calls, and tool results to and from the Codex Responses wire format.
        - [ ] Default to `gpt-5.6-terra` with `reasoning.effort: medium`; allow `--model` to override it.
        - [ ] Parse SSE deterministically, stream final answer text only, and exclude credentials and hidden reasoning from logs and run events.
        - [ ] Verify final answers, single and multiple tool calls, malformed events, authentication failures, usage limits, and transport failures without real network requests.
    - [ ] **6.5 Verify one real read-only ChatGPT Plus run**
        - [ ] Run `yo login`, confirm `yo auth status`, and complete one `yo ask` task without `OPENAI_API_KEY`.
        - [ ] Confirm that logout removes the credential and that the approved workspace remains unchanged.

- [ ] **7. Milestone 1 verification**
    - [ ] Run the full build and test suite.
    - [ ] Check the implementation against every PRD acceptance criterion.
    - [ ] Record the boundary for the next milestone: in-memory `yo chat`, retaining read-only tools only.

## Permanent constraints

- No model-visible write, shell, process, network, credential, or connector tools.
- Trusted network access is limited to ChatGPT OAuth and the OpenAI Codex model transport.
- The only trusted filesystem write is the OAuth credential store at `~/.yo/auth.json`; no writes are allowed inside the approved workspace.
- No API-key fallback, persistent agent sessions, TUI, REPL, project configuration file, device-code login, or multi-provider support in milestone 1.
- Do not mark a step complete until its scoped checks have passed and its result has been reviewed.
