# Tasks

The user authorized the remaining implementation on 2026-10-02 with a commit
after each step. Complete and verify each group before proceeding. Scoped checks
and agent review are recorded in [verification](verification.md); human result
acceptance is not inferred from automated checks. Task 8.3 remains gated on
explicit acceptance. See [design](design.md) and [capability deltas](specs/).

## 1. Trusted controller and signal contracts

- [x] 1.1 Add the small trusted turn controller with one signal, idempotent cancellation request, complete-turn settlement promise, and disposal; verify controlled-promise tests for request-before-start, repeated requests, held cleanup, rejected invocation, and stale controller isolation.
- [x] 1.2 Define optional trusted run/turn/transport/dispatch/approver signal contracts and cancellation-request event without changing model schemas or wiring CLI behavior; verify existing no-signal callers compile, controller tests pass, and registry/API tests still expose only the four existing tools.
- [x] 1.3 Record the group 1 API boundaries, focused test/build results, and review evidence in change-local verification notes; verify the notes explicitly distinguish controller readiness from user-visible cancellation and do not claim approval from tests.

## 2. Settled read and preparation operations

- [x] 2.1 Replace detached read/preparation timeout races with a signal-aware settled wrapper and first-stop-cause latch; verify held execution/cleanup tests, both timer/cancellation orders, prior committed outcomes, and exactly one result per call.
- [x] 2.2 Propagate execution signals through read authorization, file listing/search/reading, and patch preparation with checkpoints before further I/O; verify pre-abort and mid-operation tests stop subsequent paths and preserve workspace policy, output limits, and resource cleanup.
- [x] 2.3 Update affected dispatcher/filesystem tests and change-local evidence for delayed settled timeout return; verify focused tests and build, and record review of the execution-timeout versus settlement distinction before completing the group.

## 3. Cancellable input and patch review ownership

- [x] 3.1 Refactor the single persistent line reader to support explicit pending-read identity, typed approval-read cancellation, and interrupt subscription without a dangling async-iterator read; verify prompt/EOF/close regressions, pending-read release, disposal, and preservation of ordinary buffered non-TTY lines.
- [x] 3.2 Extend trusted patch approval and terminal approver options with a signal while preserving complete immutable diff and non-TTY denial; verify abort-first and consent-first orders, late cancelled-read resolution, partial/buffered input discard during cancellation, and fresh subsequent read ownership.
- [x] 3.3 Record input lifecycle and approval tests, build checks, and review in change-local evidence; verify cancellation is not denial, no second input reader exists, and no approval response or interrupt is inserted into model context.

## 4. Patch cancellation and atomic replacement

- [x] 4.1 Thread the run signal through specialized patch dispatch, settled preparation, approval, revalidation, and application; verify pre-abort, cancellation after consent, pending-review invalidation, no unapproved mutation, and one lifecycle/result trail per call.
- [x] 4.2 Compose external cancellation with the existing patch timer and pre-rename checks; verify held temporary-write/cleanup, both stop-cause orders, no rename before cancelled pre-check, and successful or failing already-started rename without fabricated rollback.
- [x] 4.3 Record focused patch/dispatcher checks, build, and review evidence; verify file bytes and applied events agree and approval-only abort still affects only that call.

## 5. Signal-aware Codex request and credential work

- [x] 5.1 Add optional cancellation to model-request credential resolution and refresh fetch, with checks around serialized storage; verify pre-abort, cancellation while waiting for storage, cancellation during refresh, valid rotated-credential persistence, lock release, and no subsequent model fetch.
- [x] 5.2 Propagate the run signal through authenticated fetch and SSE consumption with awaited body/reader cleanup and answer gating; verify pending fetch/read cancellation, HTTP-error cleanup, late completed responses/callbacks, partial confirmed text, and unchanged safe-answer/non-cancellation error behavior using local faux operations.
- [x] 5.3 Record provider/auth focused checks, build, and review evidence; verify sanitized outcomes, no credential/payload leakage, no login-flow expansion, and no new dependency or live-provider claim from faux tests.

## 6. Loop cancellation and conversation settlement

- [ ] 6.1 Propagate the turn signal through the loop and emit one ordered frozen cancellation-request event; verify pre-aborted turns, model rejection/late response, observer failures, no later model step, and both completion/cancellation commit orders.
- [ ] 6.2 Preserve accepted call batches with completed results, await the active call, and synthesize ordered aborted results/events for unstarted calls without dispatch; verify mixed multi-call accounting, exact call IDs, last-budget-step races, applied-patch evidence, and approval-only abort continuation.
- [ ] 6.3 Append the cancelled turn suffix once and gate late answer callbacks; verify conversation follow-up tests, fresh budgets, preserved confirmed partial output, no fabricated final answer, and stale callbacks unable to affect a newer turn; record focused checks, build, and review evidence.

## 7. CLI interrupt integration and observation

- [ ] 7.1 Register the trusted active controller before turn invocation and route interactive readline interrupt/non-TTY process SIGINT without duplicate handling; verify active/idle/repeated interruption, synchronous initial events, cleanup/error exits, scoped listener disposal, and no input read before settlement.
- [ ] 7.2 Project cancellation-request evidence and sticky cancelling activity, then render runtime-confirmed aborted/aborted as cancelled while preserving completed and budget outcomes; verify TTY/non-TTY presentation, observer failure isolation, frozen settlement, applied patch trails, and unchanged retained-record identity.
- [ ] 7.3 Verify cancellation followed by `/runs`, `/run N`, and a fresh task with controlled CLI/model/tool/approval promises; cover delayed cleanup, late consent, completion winning, renderer failures, and immutable history, then record focused checks/build and review evidence.

## 8. Integration verification and reviewed closure

- [ ] 8.1 Add or extend an example for cancellation and safe continuation, and verify its deterministic faux transcript covers requested versus settled cancellation, read/approval work, and retained inspection; record physical TTY Ctrl+C and patch-review recovery separately, with live-provider coverage or lack of it explicit.
- [ ] 8.2 Run `npm test`, `npm run build`, `npm run format:check`, `npm run spec:check`, and `git diff --check`; verify scenario coverage across all five deltas and record results and remaining limitations in change-local evidence for user review.
- [ ] 8.3 After explicit review acceptance, synchronize only implemented verified deltas, archive the change, and update project maps; verify structural validation, links, formatting, diff checks, and that rerun/validation remain separate unapproved work.
