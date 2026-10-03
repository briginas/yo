# Run observation delta: linked attempts

## MODIFIED Requirements

### Requirement: Session-local sequential runs

The CLI SHALL create one observation record per submitted chat task, including
each newly accepted explicit rerun, assign increasing positive session-local run
numbers, and retain earlier records for the current chat session. The CLI SHALL
execute turns sequentially. Observation SHALL permit local inspection of settled
runs between turns and SHALL add no persistence. Inspection and rejected or
duplicate rerun actions SHALL NOT allocate a run number.

#### Scenario: Consecutive tasks retain distinct records

- **WHEN** two tasks complete in one chat session
- **THEN** their records have increasing numbers and separate events and results
- **AND** the result output includes both runs in submission order

#### Scenario: A new chat starts empty

- **WHEN** a new chat observation session is created
- **THEN** its history is empty and its first task receives run number 1

#### Scenario: Inspection does not consume a run number

- **WHEN** the user inspects history between the first and second submitted tasks
- **THEN** the second task receives run number 2 regardless of inspection count or invalid selections

#### Scenario: Accepted rerun is a separate record

- **WHEN** the user reruns settled run 1 after run 2 exists
- **THEN** new run 3 has its own events, answer, timing, and result linked to run 1
- **AND** rejected selections and repeated delivery of that action do not consume run 4

### Requirement: Inspection commands are local and precisely recognized

At the between-turn chat prompt, the CLI SHALL recognize `/runs` without
arguments and `/run N` with one positive safe-integer decimal number matching
`[1-9][0-9]*`. It SHALL ignore surrounding whitespace for these commands and
allow spaces or tabs between tokens. Invalid arguments to either reserved
token SHALL produce local usage guidance. `/rerun` SHALL follow the separate
CLI-chat rerun contract; it SHALL NOT be an inspection action. All other input
SHALL retain its existing handling, including exact `/exit`, blank input, and
ordinary tasks.

#### Scenario: Valid command variants

- **WHEN** the user enters `/runs`, `/runs` with surrounding spaces, `/run 2`, or `/run` followed by a tab and `2`
- **THEN** the CLI performs the corresponding local inspection and returns to `yo>`

#### Scenario: Malformed reserved commands stay local

- **WHEN** the user enters `/run`, `/run 0`, `/run -1`, `/run 01`, `/run 1.5`, `/run 1e2`, `/run 9007199254740992`, `/run 1 extra`, or `/runs extra`
- **THEN** the CLI prints usage guidance for `/runs` and `/run N` and returns to `yo>` without invoking a turn

#### Scenario: Other input is preserved

- **WHEN** the user enters `/runner`, `/runbook`, `/RUN 1`, an ordinary task, or `/exit` with leading and trailing spaces
- **THEN** the original line is handled as a chat task without normalization
- **AND** exact `/exit`, EOF, and blank lines retain their existing exit or ignore behavior

## ADDED Requirements

### Requirement: Safe rerun provenance is visible

A rerun record SHALL retain the directly selected source's positive run number
and the fixed current-conversation policy from creation through settlement.
Its header, result card, list row, and retained inspection SHALL identify both.
Ordinary records SHALL carry no rerun provenance. Provenance SHALL contain no
full task text, transcript, input action identity, proposal, or approval.

#### Scenario: Linked attempt from start to inspection

- **WHEN** run 3 is accepted as a rerun of run 1
- **THEN** its first header and later result, list row, and `/run 3` inspection show `Rerun of #1` and `Context: current conversation`
- **AND** synchronous runtime events already belong to new run 3

#### Scenario: Link is direct and stable

- **WHEN** run 3 reruns run 2, which previously reran run 1
- **THEN** run 3 displays source 2 while run 2 still displays source 1
- **AND** later projections and settlement cannot change either source link

#### Scenario: Ordinary runs and plain output

- **WHEN** ordinary and rerun tasks coexist in a non-TTY session
- **THEN** source and policy labels appear only on rerun records as durable readable text without cursor controls or color dependency

### Requirement: Source evidence remains immutable through rerun

Creating, executing, cancelling, settling, or inspecting a rerun SHALL NOT change
its source's header, event feed, answer preview, result, linkage, or frozen timing.
Each attempt SHALL retain distinct call association and evidence. Late callbacks
SHALL NOT reopen either settled attempt or affect another attempt.

#### Scenario: Source before and after rerun

- **WHEN** the user inspects a settled source, executes its rerun, then inspects the source again
- **THEN** the source inspections contain identical retained evidence and timing
- **AND** the rerun's events and new answer appear only in its own inspection

#### Scenario: Source with applied patch and cancelled result

- **WHEN** a source contains both applied-patch evidence and a cancelled result and a later rerun completes
- **THEN** the source keeps both facts without rollback or relabelling, and the new run keeps only its own execution evidence

#### Scenario: Late callbacks across attempts

- **WHEN** old callbacks arrive during a rerun or after either attempt settles
- **THEN** each settled result and source relation stays unchanged and no callback changes a different run

### Requirement: Rerun display does not control execution

Rerun provenance, previews, inspection, rendering, diagnostics, and clock samples
SHALL NOT decide task selection, source eligibility, action identity, permissions,
budgets, or patch consent. Their failure SHALL NOT duplicate an accepted action
or alter its task, context, settlement, or previously retained source evidence.
Existing display sanitization and bounds SHALL remain in force.

#### Scenario: Lossy task display

- **WHEN** a source has a truncated or redacted preview
- **THEN** the rerun uses the complete execution task while display remains bounded and sanitized

#### Scenario: Display consumers fail

- **WHEN** rendering, projection, clock, or diagnostic output fails during rerun creation or execution
- **THEN** the accepted attempt still executes at most once through the normal runtime with its original task and source identity
- **AND** neither old consent nor additional tool authority is created

#### Scenario: Inspection remains local

- **WHEN** `/runs` or `/run N` displays rerun provenance
- **THEN** it invokes no model request, creates no rerun action or run number, and changes no transcript, timing, or permissions
