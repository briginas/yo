# Proposal

## Why

Yo can inspect files and apply an explicitly approved patch, but cannot return
executable test/build evidence. This imports the existing Milestone 5 draft into
OpenSpec so future validation work has one planning source.

**Status: unapproved draft; implementation is not authorized.** The user approved
documentation migration only. Cancellation and explicit rerun must first be
specified, implemented, and verified separately; this change must then be
reviewed against their settled contracts before any implementation leaf starts.

## What Changes

- Propose one `run_validation` tool accepting exactly `test` or `build`, with
  a fixed trusted npm catalog and no model-controlled spawn settings.
- Bound execution to the canonical workspace, no stdin, minimal environment,
  temporary home/cache, 120-second timeout, and process-tree abort-and-settle.
- Return a sanitized diagnostic tail capped at 2,000 lines and 50 KiB, with
  structured pass/failure/timeout/abort/infrastructure outcomes.
- Integrate each result once into transcript, events, observation, and evidence.
- Preserve explicit patch consent; validation does not approve patches and
  patch application does not automatically run validation.
- Treat repository scripts as trusted OS processes, not a filesystem/network
  sandbox. The proposed allowlist authorizes these two calls without an extra
  prompt; this permission expansion still needs explicit product approval.

Acceptance requires exact schema/catalog checks, settled process and output
tests, existing-tool compatibility, deterministic CLI scenarios, controlled
temporary npm fixtures for both commands, repository checks, and a reviewed
live OAuth-backed fixture flow. No such feature acceptance is claimed here.

Deferred: arbitrary commands, other validators or package managers, arguments,
workspace selection, installs, automatic validation/repair/retry/rollback,
live process-output streaming, persistent logs, approval caching, sandboxing,
remote/background execution, Git operations, and deployment.

## Capabilities

### New Capabilities

- `allowlisted-validation`: fixed test/build execution, environment, output,
  settlement, structured outcomes, and trust boundary.

### Modified Capabilities

- `agent-harness`: narrow exception to the closed no-process tool registry.
- `cli-chat`: validation-specific timeout and explicit trusted-script effects
  alongside the unchanged exact-patch approval boundary.
- `run-observation`: bounded validation diagnostics and per-call outcome evidence.

## Impact

Future implementation touches internal validation modules, dispatcher, loop,
conversation, provider definitions, system prompt, terminal/observation/evidence
formatting, and their tests. Raw process operations stay out of the public runtime
barrel. No dependency addition is planned; Node process APIs are the proposed
execution mechanism. This migration changes documentation only; main specs and
the running four-tool registry continue to describe the implemented behavior.
