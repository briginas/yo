# Spec Delta

Unapproved validation proposal; rebase against completed cancellation/rerun changes before implementation.

## MODIFIED Requirements

### Requirement: Fresh budgets and recoverable turn failure

Each CLI task SHALL start with a fresh budget of 10 model requests and a
5,000 ms read/patch execution timeout. Allowlisted validation SHALL use its
separate fixed 120-second timeout. Patch review time SHALL be excluded as
specified in approval-gated patching. Transport failure and budget exhaustion
SHALL end only the current turn, retain its structured messages, report its
sanitized outcome, and return to input. Workspace setup and input failures SHALL
terminate the chat with cleanup. Cancellation and explicit rerun SHALL follow their separately approved
contracts; validation SHALL integrate with their settled behavior.

#### Scenario: Failed turn followed by another task

- **WHEN** transport failure or budget exhaustion ends a task
- **THEN** a later task can run with a reset budget in the same conversation

### Requirement: Workspace mutation remains separately approved

Chat SHALL expose no general write or process capability. Direct model-proposed
file edits SHALL require the exact approval-gated patch workflow. The separately
authorized `run_validation` capability SHALL execute only trusted test/build
scripts; their OS-level effects can include workspace mutation without exact
patch consent, as documented in the validation trust boundary. Approval responses SHALL remain outside the transcript and SHALL
authorize only the currently displayed proposal. Closing chat SHALL discard
memory without undoing patches already successfully applied.

#### Scenario: Read-only conversation

- **WHEN** a conversation inspects files and exits without an approved patch or validation execution
- **THEN** the approved workspace remains unchanged
