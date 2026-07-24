# yo

`yo` is a small TypeScript coding-agent harness for learning how model/tool loops work. It lets a model inspect one approved workspace through a closed set of read-only tools and returns an evidence-backed answer without giving the model direct filesystem, process, credential, or network access.

The project takes architectural inspiration from [`pi`](../pi), especially its separation between the agent loop, model transport, tool execution, and interactive presentation. `yo` intentionally keeps a smaller boundary: one Codex transport, one bounded single-agent loop, and three read-only tools with local validation and permission checks.

## Current status

Milestone 1 is complete: `yo ask` supports a bounded read-only task through ChatGPT Plus OAuth. [Milestone 2](IMPLEMENTATION_PLAN.md) is planned as an in-memory `yo chat` command with multiple turns and live terminal feedback; it does not add persistence, write tools, shell execution, MCP, or subagents.

## Requirements and setup

- Node.js `22.18.0` or newer
- npm
- A ChatGPT Plus account for real Codex requests

```bash
npm ci
npm run build
```

No `OPENAI_API_KEY` is used. Authentication is completed through the OpenAI website:

```bash
node dist/cli.js login
node dist/cli.js auth status
```

The resulting OAuth credential is trusted CLI state stored at `~/.yo/auth.json`. It is not exposed to the model or available through a tool.

## Usage

Run a read-only task against an explicitly approved workspace:

```bash
node dist/cli.js ask "Find where CLI arguments are parsed" --cwd /path/to/workspace
```

Override the default model when needed:

```bash
node dist/cli.js ask "Explain the runtime loop" --cwd /path/to/workspace --model <name>
```

Remove the stored credential:

```bash
node dist/cli.js logout
```

## Safety boundary

The model-visible registry contains exactly:

- `list_files`
- `search_code`
- `read_file`

The harness treats every model-proposed tool name and argument object as untrusted. Application code performs closed lookup, strict schema validation, workspace permission checks, bounded execution, and structured result creation. Every requested tool call receives exactly one result, including denial, invalid arguments, timeout, or execution failure.

The model cannot invoke writes, patches, shell commands, processes, arbitrary network requests, credential access, or environment-variable reads. Trusted network access is limited to ChatGPT OAuth and the Codex model transport.

## Project map

| Path             | Role                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `src/runtime/`   | Provider-neutral contracts, bounded agent loop, permissions, read-only tools, and workspace enforcement |
| `src/provider/`  | ChatGPT Codex Responses transport and provider-format conversion                                        |
| `src/auth/`      | OAuth login, credential contracts, refresh, and secure file storage                                     |
| `src/cli-app.ts` | Injectable CLI parsing, command composition, output, and evidence reporting                             |
| `src/cli.ts`     | Thin Node process entrypoint                                                                            |

## Documentation map

- [`AGENTS.md`](AGENTS.md) — collaboration rules and the required workflow for changing the repository.
- [`PRD.md`](PRD.md) — stable product boundaries and links to milestone-specific requirements.
- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — current milestone state, permanent constraints, and links to detailed plans.
- [`docs/requirements/`](docs/requirements/) — milestone-specific scope and acceptance criteria, read when that milestone is relevant.
- [`docs/plans/`](docs/plans/) — active implementation details and completed milestone summaries.

These files have separate roles. Requirements and milestone state should not be copied into this README beyond a short orientation because duplicated details become stale.

## Verification

```bash
npm test
npm run build
npm run format:check
git diff --check
```

Tests use faux transports, injected HTTP, temporary credential stores, and fixture workspaces so normal verification does not require real credentials, network requests, or paid model calls.
