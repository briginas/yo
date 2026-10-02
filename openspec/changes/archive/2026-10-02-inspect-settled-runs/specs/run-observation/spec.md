# Spec Delta

## MODIFIED Requirements

### Requirement: Session-local sequential runs

The CLI SHALL create one observation record per submitted chat task, assign
increasing positive session-local run numbers, and retain earlier records for
the current chat session. The CLI SHALL execute turns sequentially. Observation
SHALL permit local inspection of settled runs between turns and SHALL add no
persistence. Inspection SHALL NOT allocate a run number.

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

### Requirement: Answer delivery is preserved alongside results

The existing answer renderer SHALL deliver the full answer once during each
turn. Afterwards the CLI SHALL print a result card with outcome, reason,
timing, tools, files, errors, patch trails, and the session run list without
repeating the stored answer preview or legacy operational status lines.
An explicit `/run N` inspection SHALL separately display the retained answer
preview without replaying runtime answer events or invoking the model.

#### Scenario: Full answer exceeds observation preview limit

- **WHEN** the final answer is longer than the retained display preview
- **THEN** the answer renderer delivers the full answer once and the result card does not duplicate it

#### Scenario: Progress cleanup fails during streaming

- **WHEN** line clearing or cursor movement fails while answer fragments are delivered
- **THEN** later cleanup does not erase an already delivered fragment

#### Scenario: User explicitly requests a prior answer

- **WHEN** the user enters `/run 1` after run 1 settles with an answer
- **THEN** the inspection prints its stored safe preview once, separately labelled as a retained answer
- **AND** automatic answer delivery and the conversation remain unchanged

## ADDED Requirements

### Requirement: Inspection commands are local and precisely recognized

At the between-turn chat prompt, the CLI SHALL recognize `/runs` without
arguments and `/run N` with one positive safe-integer decimal number matching
`[1-9][0-9]*`. It SHALL ignore surrounding whitespace for these commands and
allow spaces or tabs between tokens. Invalid arguments to either reserved
token SHALL produce local usage guidance. All other input SHALL retain its
existing handling, including exact `/exit`, blank input, and ordinary tasks.

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

### Requirement: Session run list is inspectable

The `/runs` command SHALL list current-session records in submission order with
run number, safe task preview, status, stop reason, local start time, and frozen
elapsed duration or `unavailable`. Empty history SHALL produce an explicit
empty-state message. List output SHALL include usage guidance for `/run N` and
SHALL NOT print answers or operational event feeds.

#### Scenario: Empty session

- **WHEN** `/runs` is entered before any task
- **THEN** the CLI reports that no runs exist and shows inspection usage without contacting the model

#### Scenario: Completed and failed runs coexist

- **WHEN** `/runs` is entered after completed, transport-failed, and budget-exhausted runs
- **THEN** each appears in submission order with its recorded outcome, reason, and unchanged timing

### Requirement: Selected settled run is rendered from retained evidence

The `/run N` command SHALL display only the selected settled run's header,
ordered event feed, retained answer preview, and result card. It SHALL identify
the run, label the answer as retained, mark truncation, and explicitly indicate
an absent answer. It SHALL preserve safe previews, call association, tool
truncation, frozen timing, errors, and patch trails. An unknown or unsettled run
SHALL produce a local diagnostic without displaying another run as a fallback.

#### Scenario: Switching runs preserves association

- **WHEN** the user inspects run 2, run 1, then run 2 again
- **THEN** each view contains only that run's original ordered evidence and result, with identical frozen timing on repeated views
- **AND** viewing neither mutates the records nor changes the default behavior of the next chat task

#### Scenario: Retained answer is truncated or absent

- **WHEN** the selected run has a truncated answer preview or has no final answer
- **THEN** the CLI displays the stored preview with an explicit truncation notice, or an explicit no-answer label, respectively
- **AND** it does not fetch full text from the conversation, expose raw tool output, or infer a missing answer

#### Scenario: Invalid selection

- **WHEN** `/run N` identifies no record or an unsettled record
- **THEN** the CLI reports that the requested run is unavailable or not settled, respectively, and returns to the prompt
- **AND** no record, timing, or model message changes

### Requirement: Inspection preserves execution and input ownership

Inspection SHALL run only between turns and SHALL NOT invoke the model,
allocate or execute a turn, alter the transcript, resample run clocks, or change
permissions or consent. It SHALL NOT read input concurrently with execution
or patch approval. Rendering and diagnostic failures SHALL remain local and
allow subsequent chat. Inspection output SHALL use durable text, require no
color or cursor controls, and be available through keyboard input.

#### Scenario: Follow-up after inspection

- **WHEN** ordinary tasks are separated by valid or invalid inspection commands
- **THEN** model requests, conversation messages, and runtime outcomes match the equivalent flow without those commands

#### Scenario: Approval owns command-like input

- **WHEN** `/runs` or `/run 1` is entered at the exact-patch approval prompt
- **THEN** the existing approver consumes it as a non-affirmative response and denies that patch
- **AND** no inspection, queued command replay, or consent is created from that response

#### Scenario: A turn is still working

- **WHEN** a model request or tool operation is pending
- **THEN** the CLI starts no additional chat or navigation read before the turn settles

#### Scenario: Inspection output fails

- **WHEN** an inspection writer and its diagnostic writer throw
- **THEN** stored records, conversation, and last session remain intact and the next chat task can still run
- **AND** raw thrown diagnostics are not displayed

#### Scenario: Plain terminal and session reset

- **WHEN** inspection runs in non-TTY mode or without color, then the user exits and starts a new chat
- **THEN** inspection remains readable without cursor controls, the previous history is discarded, and `/runs` in the new chat is empty
- **AND** non-TTY patch approval remains denied under the existing policy
