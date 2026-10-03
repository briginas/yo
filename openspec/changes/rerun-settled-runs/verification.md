# Verification: Explicit rerun of settled runs

## Authorization and coverage boundary

On 2026-10-03 the user requested the planning artifacts and selected current
conversation context. After the first implementation candidate was presented,
the user's “ok. continue” authorized **group 1 only**: pure parser, trusted task
catalog, action receipts, focused tests, and this evidence.

This does not record human result acceptance or authorize groups 2–6. CLI rerun
is not yet enabled. No input-arrival, observation integration, actual rerun model
request, changed-file/patch rerun, PTY, physical-keyboard, or live-provider
verification is claimed for this group.

## Group 1 staged checks and review

### Task 1.1: Pure parser

- Added `src/rerun-command.ts` and its adjacent tests without importing execution,
  observation, filesystem, input, or provider code.
- `node --test src/rerun-command.test.ts`: **3 passed, 0 failed**.
- Coverage includes canonical positive safe numbers through `MAX_SAFE_INTEGER`,
  whitespace/tab variants, all malformed forms in the delta, numeric overflow,
  nondecimal input, and preservation of ordinary/existing command tokens.
- Agent review: matches existing local-command grammar; returns classifications
  only and cannot allocate a run, normalize ordinary task content, or invoke work.
  No review finding required a fix at this step.

### Task 1.2: Trusted attempt catalog

- Added `src/chat-runs.ts` and its adjacent tests. A new catalog starts at 1;
  `firstRunId` is a programmatic allocator test seam to exercise safe-integer
  exhaustion without trillions of reservations, not a CLI/runtime setting.
- `node --test src/chat-runs.test.ts`: **7 passed, 0 failed** at this stage.
- `npm run build`: passed strict TypeScript checking and CLI bundling.
- Coverage includes independent session catalogs, ordinary repeated tasks,
  missing/unsettled/invalid sources, all four valid terminal pairs, exact long
  whitespace/Unicode task text, direct rerun chains, frozen detached snapshots,
  invalid settlement pairs, extra session fields excluded from retained outcome,
  idempotent settlement, and allocation through the maximum safe number.
- Agent review: the catalog has no I/O, callbacks, observer imports, transport,
  or consent objects. Settlement uses a local Zod schema and retains only the
  terminal pair. Returned snapshots cannot rewrite the source. Boundary tests
  confirmed failed reservations consume no number. No fix was needed.

### Task 1.3: Action receipts

- Final `reserveRerun(sourceId, windowId)` reserves one attempt for each numeric
  pair. Window 0 permits initial buffered input; later windows must be nonnegative
  safe integers supplied by trusted input ownership in subsequent work.
- Receipts live for the catalog/session lifetime. Repeat delivery returns a
  detached snapshot of the original accepted attempt, including its settled
  outcome when applicable. Failed reservations create no receipt or run number.
- `node --test src/rerun-command.test.ts src/chat-runs.test.ts`: **14 passed,
  0 failed** (3 parser tests and 11 catalog tests).
- `npm run build`: passed after the receipt API and its tests were added.
- Coverage includes immediate duplicate acceptance, duplicate delivery after
  cancellation settlement, deliberate new-window attempts, distinct sources with
  identical task text, invalid windows, rejected actions later becoming eligible,
  ordinary repeated tasks, and old receipts surviving allocator exhaustion.
- Agent review: reservation and receipt insertion are synchronous with no
  callback/await boundary. Receipt lookup precedes allocation, survives settlement,
  and targets a retained run. Added a lifetime-invariant comment at the non-null
  lookup; no behavioral fix was required. The tests exercise catalog delivery,
  not yet native buffered input or actual model execution.

## Group 1 API and scope review

| API                                | Contract                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `parseRerunCommand(line)`          | Returns `rerun` with source ID, `invalid`, or `message`; performs no execution.                                      |
| `createChatRunCatalog()`           | Starts a private in-memory catalog at run 1 with no I/O.                                                             |
| `reserveTask(task)`                | Preserves full task text, reserves the next ID, and never deduplicates ordinary tasks.                               |
| `reserveRerun(sourceId, windowId)` | Requires a known settled source and safe arrival identity; returns accepted, duplicate, or a fixed rejection reason. |
| `settle(id, outcome)`              | Accepts only a valid runtime terminal status/reason pair, strips extra fields, and preserves the first settlement.   |
| `get(id)`                          | Returns a detached frozen snapshot or null, without changing catalog state.                                          |

Source task/linkage and settlement snapshots remain private execution data;
no display record, model tool schema, consent, signal, transcript, or provider
payload is stored in this catalog. The modules are not imported by CLI, input,
runtime, or observation composition yet. Existing CLI run allocation and input
handling remain as implemented before this leaf.

The verification covers the pure parts of source selection, exact task reuse,
action identity, direct linkage, and immutability. Current-conversation submission,
native arrival-window generation, changed-file reads, new patch consent, and
retained display provenance remain unimplemented in later groups.

## Group 1 scoped completion checks

On 2026-10-03:

- Focused parser/catalog suite: **14 passed, 0 failed**.
- `npm run build`: passed strict TypeScript checking and CLI bundling.
- `npm run format:check`: passed after scoped formatting of new files.
- `npm run spec:check`: **7 items passed, 0 failed**. Existing informational
  long-requirement notices do not change their current behavior or scope.
- `git diff --check`: passed for tracked edits; additional whitespace checks
  covered untracked new code/artifacts. **41 local links** were checked.
- Composition-import review found no premature imports of either new module
  from existing CLI/runtime/input/observation files. API/evidence review matches
  the checked source and explicitly leaves actual CLI rerun disabled.

Tasks 1.1–1.4 are implemented, scoped-checked, and agent-reviewed. Human result
acceptance has not been inferred from these checks. No full repository runtime
test run or end-to-end rerun verification is claimed. The next candidate is
group 2, which requires separate bounded confirmation. Main behavioral specs
have not been synchronized and the change has not been archived.
