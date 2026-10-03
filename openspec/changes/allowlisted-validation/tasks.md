# Tasks

**Unapproved imported draft. No implementation task is authorized.** Artifact
completeness is not permission to execute this plan. Each group is a separate
bounded leaf requiring confirmation; original Milestone 5 leaf numbers are
shown for continuity. Run focused tests and applicable repository checks,
review the result, and record evidence before completing each leaf.

## 0. Prerequisite review gate

- [ ] 0.1 Complete the broader compatibility review against implemented cancellation and explicit rerun, including remaining design assumptions and all deltas, with a reviewed compatibility diff. Their settled contracts are linked and the limited CLI budget-block repair is recorded below; that repair does not complete this gate.
- [ ] 0.2 Review the imported permission policy, trusted script effects, platform process support, and cancellation integration with the user; record explicit approval of scope and first bounded leaf before code changes. Documentation-migration approval does not satisfy this task.

## 1. Contracts, catalog, and pure output bounds (11.1)

- [ ] 1.1 Add strict enum contracts, immutable fixed npm catalog, timeout/output constants, and safe metadata/result formatting; verify schema rejection, exact argv, and result-mapping tests.
- [ ] 1.2 Add an incremental output accumulator; test UTF-8 chunk boundaries, malformed bytes, split ANSI/control sequences, mixed streams, long lines, exact and exceeded byte/line limits, diagnostic tail, empty/final-newline behavior, and bounded memory.
- [ ] 1.3 Document the internal contract and run focused checks plus build, full tests, formatting, spec validation, and diff review; verify no child process, dispatcher registration, public executor export, provider definition, prompt, or CLI behavior was added.

## 2. Abort-and-settle executor (11.2)

- [ ] 2.1 Add an internal executor with injected operations, minimal environment, temporary home/cache, fixed cwd/argv, ignored stdin, and piped streams; test exact spawn settings, environment isolation, normal exit, non-zero exit, and spawn failure.
- [ ] 2.2 Implement fixed timeout, run-abort propagation, process-tree termination/escalation, stream settlement, and cleanup; test late exit, ignored termination, stream/cleanup failures, and no returned timeout before owned work settles.
- [ ] 2.3 Document supported platform behavior and detached-process limitations; verify platform-specific operation tests and repository checks while `run_validation` remains unregistered and model-invisible.

## 3. Closed dispatcher integration (11.3)

- [ ] 3.1 Add strict validation and fixed-allowlist dispatch; test both identifiers, missing/extra/unknown arguments, and no process or allow decision after invalid input.
- [ ] 3.2 Map each executor outcome to one result with call ID, validation/truncation metadata, and safe errors; test conflicts between completion callbacks, timeout/abort, injected failures, one permission decision, and no duplicate settlement.
- [ ] 3.3 Document the validation-specific dispatch path and verify focused/full checks and review; keep `ToolName`, normal visible-tools, provider definitions, and prompt unchanged.

## 4. Loop, conversation, observation, and evidence (11.4)

- [ ] 4.1 Thread injected validation execution and the settled cancellation contract through loop/conversation options; test sequential multiple calls, failed validation continuation, retained failed-turn context, and one ordered transcript result/event per call.
- [ ] 4.2 Add safe enum status summaries, ordered validation evidence, and observation outcomes with bounded diagnostics; test pass versus test failure versus executor failure, exit codes, truncation, exact-once display, and no unconfirmed pass claims.
- [ ] 4.3 Test renderer/observer failure isolation, existing answer delivery, unchanged input/patch consent, and read-tool compatibility; document the fields and review repository checks with provider visibility still disabled.

## 5. Provider activation and guidance (11.5)

- [ ] 5.1 Activate only `run_validation` in `ToolName`, visible-tools, and the Codex strict enum definition after enforcement is verified; run provider parity and runtime public-export allowlist tests without exposing raw process operations.
- [ ] 5.2 Update prompt and README guidance for test/build, optional baseline/post-patch use, one-at-a-time dependent calls, accurate evidence, and trusted unsandboxed scripts; verify examples against the schema and tests and run all repository checks.

## 6. Integrated CLI and real-process fixtures (11.6)

- [ ] 6.1 Add faux chat flows covering test/build pass and failure, timeout, abort, and patch-then-validation; verify no extra approval read, no validation input in the user transcript, one result, and continued chat after failure.
- [ ] 6.2 Run controlled temporary npm fixtures for both exact mappings, pre/post-hook suppression, ignored stdin, sentinel-secret absence, captured output, truncation, non-zero exits, timeout settlement, and cleanup; use no real OAuth, network, home credentials, or user checkout scripts.
- [ ] 6.3 Document the repeatable fixture procedure and platform limits; run scoped and full checks and review that no capability beyond the enum was added.

## 7. Verification and closure (11.7)

- [ ] 7.1 Run focused checks, all tests, build, formatting, strict OpenSpec validation, and diff checks; review the full change for process safety, secrets, capability drift, and unrelated changes, recording results.
- [ ] 7.2 Complete a manually reviewed ChatGPT OAuth-backed flow in a disposable trusted workspace: inspect, approve one patch, request a selected validation, and check exact evidence. Record actual review and any platform or live-verification limitation without inventing acceptance.
- [ ] 7.3 After implementation checks and result review, synchronize only verified deltas, archive this change, and update PRD, IMPLEMENTATION_PLAN, and README; validate spec consistency and local links. Do not mark draft requirements implemented merely because artifacts exist.

## Limited CLI delta repair (2026-10-03)

The user explicitly requested “делай. коммить после” on the reported global
`spec:check` failure caused by two omitted rerun scenarios. This authorizes this
documentation repair and its commit only; it does not approve the validation
feature, process policy, or an implementation leaf.

`Fresh budgets and recoverable turn failure` in the
[CLI delta](specs/cli-chat/spec.md) now retains the
[current requirement](../../specs/cli-chat/spec.md), including settled
cancellation, explicit rerun, no automatic retry, and all three scenarios.
`Rerun after budget exhaustion` and `Failure without explicit request` are
restored verbatim. The only requirement-text change remains the already proposed
5,000 ms read/patch timeout plus a separate fixed 120-second validation timeout.
The other CLI requirement, other deltas, current specs, archives, config, and
runtime remain unchanged.

This is a limited preparation fix, not a completed compatibility review. Task
0.1 remains unchecked; its broader design/delta review, including historical
generic-timeout assumptions, is still pending. Task 0.2 and every implementation
task remain unchecked. Checks and review of this repair are recorded below.

Verification and review of this documentation repair:

- Exact comparison of the modified budget requirement against the current main
  requirement confirms that only the already proposed timeout distinction
  differs; all three current scenarios are retained and both restored scenarios
  match verbatim. The other CLI requirement and delta preamble are unchanged.
- `npm run spec:check`: **6 passed, 0 failed** (five current specifications and
  the validation draft), with existing informational long-requirement notices.
- `npm run format:check` and `git diff --check`: passed. Local-link review checks
  **84 links and 17 heading fragments** across the seven edited Markdown files.
- The parent reviewed the bounded diff and found no issues. All **22** task
  checkboxes remain unchecked. No runtime tests were rerun for this
  documentation-only change, and no new runtime or feature acceptance is claimed.
