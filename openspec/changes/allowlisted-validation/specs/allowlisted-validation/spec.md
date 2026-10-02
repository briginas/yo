# Allowlisted validation delta

## Purpose

Define narrow, trusted-workspace execution of the repository's test and build
scripts, with bounded diagnostics and truthful settled outcomes. This is an
unapproved proposal; it is not implemented behavior.

## ADDED Requirements

### Requirement: Exactly two validation identifiers

`run_validation` SHALL accept exactly `{ command: 'test' }` or
`{ command: 'build' }`. Missing, unknown, or extra properties SHALL fail before
any process starts. The model SHALL NOT choose executable, argv, selectors,
paths, cwd, environment, shell, timeout, or output limits.

#### Scenario: Broader arguments

- **WHEN** a call requests `lint`, supplies arguments, or omits the command
- **THEN** it returns one invalid-arguments result without starting a process

### Requirement: Trusted fixed npm catalog

Trusted code SHALL map `test` to `npm test --ignore-scripts --offline --audit=false --fund=false`
and `build` to `npm run build --ignore-scripts --offline --audit=false --fund=false`.
The harness SHALL pass executable and fixed argv separately without shell
interpolation of model data. Platform executable selection SHALL be internal.

#### Scenario: Lifecycle suppression and missing script

- **WHEN** validation selects a script
- **THEN** only the explicitly selected npm script runs, with pre/post lifecycle hooks suppressed and npm registry access configured offline
- **AND** a missing script produces npm's non-zero validation failure rather than installation or fallback to another command

### Requirement: Fixed workspace and ignored stdin

Validation SHALL run at the canonical approved workspace root with no stdin
and piped stdout/stderr. It SHALL use a fixed 120-second timeout, independent
of read/patch timeouts, with no model or CLI override.

#### Scenario: Spawn settings

- **WHEN** either identifier is executed
- **THEN** the child uses the fixed workspace root, cannot consume terminal or approval input, and receives the same fixed validation timeout

### Requirement: Minimal temporary environment

The child SHALL receive only platform startup/PATH values, temporary-directory
variables, fresh per-call home/cache locations, and non-interactive flags
`CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`, `TERM=dumb`. OAuth data, API keys, npm
tokens, proxy credentials, and unrelated parent variables SHALL NOT be copied.
Temporary home/cache SHALL be cleaned after process settlement.

#### Scenario: Ambient credential sentinel

- **WHEN** the parent environment contains a credential sentinel
- **THEN** a controlled child fixture cannot find it in its environment and its temporary home/cache are cleaned after settlement

### Requirement: Terminate and settle before returning

Timeout or run abort SHALL terminate the harness-owned process tree, await
settlement, drain or close streams, and clean temporary state before returning
one result. A fixed grace period with force-kill escalation SHALL be permitted.
The harness SHALL NOT intentionally detach known descendants or return a
timeout solely from a race against ongoing process work.

#### Scenario: Ignored graceful termination

- **WHEN** a controlled process ignores the initial termination signal
- **THEN** termination escalates and the tool waits for settlement before reporting timeout or abort

### Requirement: Incremental sanitized diagnostic tail

stdout/stderr SHALL be decoded as UTF-8 with replacement for malformed bytes,
combined in observed arrival order, and stripped of ANSI and unsafe terminal
controls. Buffering SHALL remain bounded throughout execution, retaining the
most recent complete diagnostic tail within 2,000 logical lines and 50 KiB of
UTF-8 text. No live process-output streaming or persistent harness log is added.

#### Scenario: Split controls and excessive output

- **WHEN** output splits multibyte text or ANSI controls across chunks and exceeds either limit
- **THEN** the retained tail is sanitized and bounded without accumulating the complete prior output

### Requirement: Accurate truncation metadata

Truncated diagnostics SHALL identify the limiting reason, limit, and observed
count using the existing truncation vocabulary. Exactly fitting output SHALL
remain complete. Empty output, long lines, and final-newline handling SHALL be
deterministic.

#### Scenario: Exact bound and overflow

- **WHEN** output fits exactly and then a further complete diagnostic line arrives
- **THEN** only the overflow causes truncation, the newest fitting tail is retained, and metadata reports the applicable limit

### Requirement: Deterministic summary and metadata

Each result SHALL begin with command identifier, fixed display command,
outcome, available exit code, and truncation status. Safe structured validation
metadata SHALL contain `command`, `displayCommand`, `outcome`, and nullable
`exitCode`, alongside existing truncation metadata.

#### Scenario: Build failure summary

- **WHEN** build exits with code 2
- **THEN** the result identifies `build`, `npm run build`, `failed`, exit 2, and whether diagnostics were truncated

### Requirement: Distinguish validation failure from infrastructure failure

Exit 0 SHALL map to `success` / `passed`; non-zero exit to `execution_error` /
`validation_failed` / `failed`; timeout to `timeout` / `validation_timeout`;
abort to `aborted` / `validation_aborted`. Spawn, stream, or cleanup failure
SHALL map to `execution_error` / `validation_execution_error` with sanitized
diagnostics. Partial bounded output SHALL be retained for failure, timeout,
and abort when available.

#### Scenario: Unavailable executable versus failing test

- **WHEN** a test fails an assertion or npm cannot start
- **THEN** the first is a validation failure and the second an infrastructure failure; neither is reported as passed

### Requirement: One ordered loop observation

Validation SHALL use the existing requested, authorized, and completed tool
events and append one result per call with the original call ID. Invalid input
SHALL start no process and emit no allow decision; accepted identifiers SHALL
emit one allow decision. Calls SHALL remain sequential under the model-step
budget with no automatic retry, repair, rollback, or command reordering.

#### Scenario: Failed validation followed by model work

- **WHEN** validation fails and steps remain
- **THEN** the model receives its single structured result and may choose the next action without an automatic repair loop

### Requirement: Validation and patch permissions remain distinct

The proposed permission policy SHALL authorize only the two fixed identifiers
for the selected trusted workspace, without an extra validation prompt.
Validation SHALL NOT approve or apply a patch. Patch application SHALL NOT
automatically trigger validation. Baseline validation before a patch and
explicit validation after a patch SHALL both be supported.

#### Scenario: Patch then optional validation

- **WHEN** a patch is approved and applied
- **THEN** no validation starts until separately requested, and a validation call cannot reuse patch consent as authority for another patch

### Requirement: Truthful evidence and provider exposure

The provider SHALL expose only the strict validation enum after enforcement
is complete. Tool/prompt guidance SHALL explain script selection, optional
baseline/post-patch use, non-zero exit meaning, and absence of installs or
automatic repair. Evidence SHALL include a `Validations:` section with ordered
command outcomes; a pass claim SHALL require a confirming exit-0 result for
that particular identifier.

#### Scenario: Test passes but build was not run

- **WHEN** only `test` has a confirming exit-0 result
- **THEN** evidence reports test passed and does not claim build passed

### Requirement: Honest trusted-script boundary

Documentation and help SHALL identify repository scripts as trusted code with
the OS permissions of yo. Offline npm and a minimal environment SHALL NOT be
described as filesystem/network sandboxing. Scripts can modify files, invoke
dependencies, spawn descendants, access OS-readable files, and make network
calls. Deliberately detached repository processes remain outside settlement
guarantees; untrusted repositories require a separate sandbox design.

#### Scenario: Script side effects

- **WHEN** a trusted build creates files or its own network request
- **THEN** the harness does not claim workspace immutability or isolation merely because the command identifier was allowlisted

### Requirement: Compatibility and bounded scope

Existing read, exact-patch approval, OAuth, transcript, answer, and renderer
isolation behavior SHALL remain compatible except for explicitly proposed
validation extensions. No additional runners, identifiers, installs, user-defined
commands, npm workspace selection, persistent logs, background jobs, new UI
framework, remote executor, Git operations, or deployment SHALL be added.

#### Scenario: Existing tool regression checks

- **WHEN** the validation tool is enabled
- **THEN** the existing read/patch/chat/authentication tests still pass and unsupported command families remain unavailable
