# Implementation plan

Run and review the checks for each step before moving to the next one.

- [x] **1. Project foundation**
  - [x] Initialize the local Git repository and npm/TypeScript project.
  - [x] Add minimal `build`, `test`, and `dev` commands.
  - [x] Verify that an empty CLI builds and runs.

- [ ] **2. Runtime contracts**
  - [ ] Define runtime-independent types for run state, events, tool calls, and tool results.
  - [ ] Add Zod schemas for future tool arguments.
  - [ ] Verify types and basic unit tests for the contracts.

- [ ] **3. Safe read-only filesystem layer**
  - [ ] Implement `--cwd` canonicalization, the permission policy, and list/search/read tools.
  - [ ] Add limits for paths, output size, lines, results, and timeouts.
  - [ ] Verify traversal denial, truncation, and the absence of write/process APIs.

- [ ] **4. Agent loop with faux transport**
  - [ ] Implement the bounded model-to-tool-to-result loop.
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
