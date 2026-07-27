# yo

`yo` is a small TypeScript coding-agent harness for learning how model/tool loops work. It lets a model inspect one approved workspace and, for one narrow case, propose an exact patch that the trusted terminal must approve before writing. It returns an evidence-backed answer without giving the model direct filesystem, process, credential, or network access.

The project takes architectural inspiration from [`pi`](../pi), especially its separation between the agent loop, model transport, tool execution, and interactive presentation. `yo` intentionally keeps a smaller boundary: one Codex transport, one bounded single-agent loop, three read-only tools, and one approval-gated exact-patch proposal with local validation and permission checks.

## Current status

Milestone 1 established the original bounded read-only harness. Its one-shot
`yo ask` command has since been retired in favor of the single agent workflow:
`yo chat`. The chat supports an ephemeral multi-turn conversation through
ChatGPT Plus OAuth with live model/tool status and safe final-answer delivery.
Milestone 3 is complete: the model may propose an exact replacement patch for
one existing workspace file, but the harness displays the complete diff and
writes only after explicit terminal approval.
[See the current project state →](IMPLEMENTATION_PLAN.md)

Milestone 4 is drafted for review: one proposed `run_validation` tool would
allow only the repository's `test` and `build` npm scripts through a fixed
harness-owned command catalog. No process implementation is authorized yet.
General shell execution, persistence, MCP, and subagents are not implemented.
[Review the proposed Milestone 4 requirements →](docs/requirements/milestone-4-allowlisted-validation.md)

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

Start an in-memory interactive chat against an explicitly approved workspace:

```bash
node dist/cli.js chat --cwd /path/to/workspace
```

Override the default model when needed:

```bash
node dist/cli.js chat --cwd /path/to/workspace --model <name>
```

Use the exact `/exit` command or EOF to leave chat. The transcript is discarded
when the process exits.

When the model proposes a patch, `yo` displays the full diff and asks `Apply
this patch? [y/N]`. Only `y` or `yes` approves; any other input, EOF, missing
interactive input, or non-TTY execution denies it without changing the
workspace. A proposal can target only one existing regular text file and is
revalidated immediately before the trusted atomic replacement.

Remove the stored credential:

```bash
node dist/cli.js logout
```

## Safety boundary

The model-visible registry contains exactly:

- `list_files`
- `search_code`
- `read_file`
- `propose_patch`

The harness treats every model-proposed tool name and argument object as untrusted. Application code performs closed lookup, strict schema validation, workspace permission checks, bounded execution, and structured result creation. Every requested tool call receives exactly one result, including denial, invalid arguments, timeout, or execution failure.

`propose_patch` is untrusted proposal data, not a write primitive. The model
cannot directly invoke writes, shell commands, processes, arbitrary network
requests, credential access, or environment-variable reads. Trusted network
access is limited to ChatGPT OAuth and the Codex model transport.

## Project map

| Path             | Role                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime/`   | Provider-neutral contracts, bounded agent loop, permissions, read tools, approval-gated patches, and workspace enforcement |
| `src/provider/`  | ChatGPT Codex Responses transport and provider-format conversion                                                           |
| `src/auth/`      | OAuth login, credential contracts, refresh, and secure file storage                                                        |
| `src/cli-app.ts` | Injectable CLI parsing, command composition, output, and evidence reporting                                                |
| `src/cli.ts`     | Thin Node process entrypoint                                                                                               |

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
