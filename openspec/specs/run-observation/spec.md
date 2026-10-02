# Run observation

## Purpose

Describe the implemented Milestone 4 leaves 10.1–10.3: session-local run
records, ordered display projection, live terminal observation, and local
between-turn inspection with `/runs` and `/run N`. This is
the current requirement source for that migrated behavior. The
[development guide](../../../CONTRIBUTING.md) describes the workflow;
[archived change evidence](../../changes/archive/2026-10-02-inspect-settled-runs/verification.md)
records inspection and first-version closure checks. Deferred cancellation,
rerun, and validation are sequenced in the
[project-state map](../../../IMPLEMENTATION_PLAN.md).

## Requirements

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

### Requirement: Observation exists before execution

The CLI SHALL save each run record and prepare an observer bound to its identity
before invoking the existing turn. Subsequent callbacks SHALL target that run.

#### Scenario: Runtime emits synchronously during invocation

- **WHEN** the turn emits its first event before returning control to the CLI
- **THEN** the record and bound observer already exist and that event updates the correct run

#### Scenario: Record is unexpectedly absent

- **WHEN** an observation callback references a missing record
- **THEN** the trusted observation layer emits a fixed safe missing-record diagnostic
- **AND** diagnostic failure does not change execution, transcript, permissions, or patch consent

### Requirement: Lifecycle is separate from activity

An observed run SHALL remain running while starting, waiting for the model,
executing tools, waiting for patch approval, or finishing. A settled session
SHALL determine the final outcome and stop reason. The display SHALL distinguish
completed, failed, aborted, and budget-exhausted outcomes without inventing
user cancellation or transport diagnostics.

#### Scenario: Finishing event precedes settled session

- **WHEN** the runtime emits `run_finished`
- **THEN** the event is retained as feed evidence and the record remains running until session settlement

#### Scenario: Tool failure is followed by a successful answer

- **WHEN** a tool returns an error and the settled session completes with an answer
- **THEN** the result is completed and still contains the tool error evidence

#### Scenario: Budget, transport, and invocation failures differ

- **WHEN** the session reports `step_budget_exhausted` or `transport_error`, or the CLI turn invocation unexpectedly throws
- **THEN** observation respectively reports budget exhaustion, the safe transport-error reason, or display-only `cli_turn_error`
- **AND** it preserves available partial evidence without fabricating cancellation or raw error diagnostics

### Requirement: Settlement is final

Observation SHALL finalize a record at most once. Repeated settlement and late
callbacks SHALL neither reopen a settled record nor change its result, timing,
or event feed. An old observer SHALL NOT update a newer run. Expected callbacks
for settled records SHALL NOT be diagnosed as missing records.

#### Scenario: Old callbacks arrive during a new run

- **WHEN** a settled run receives more events or another settlement while a later run exists
- **THEN** both runs retain their correct identity and the earlier result remains unchanged

### Requirement: Ordered events retain call association

The feed SHALL preserve received runtime order for run, model, tool, permission,
and patch lifecycle events. Tool rows SHALL retain association with model step
and call identity even for repeated tool names. Terminal output SHALL use local
call numbers rather than raw call identifiers. Final-answer text and deltas
SHALL NOT become operational feed rows.

#### Scenario: Repeated tool calls have different outcomes

- **WHEN** separate calls to the same tool are denied, invalid, timed out, or fail execution
- **THEN** each outcome remains a distinct row associated with its own call and step

#### Scenario: Answer arrives as text deltas

- **WHEN** the runtime emits answer deltas and a final answer
- **THEN** the operational feed contains neither the answer text nor one row per delta

### Requirement: Observation retains bounded safe display data

Observation SHALL retain summaries rather than raw tool arguments, tool output,
transport payloads, credentials, hidden reasoning, or patch contents. Task and
file previews SHALL be bounded to 160 Unicode characters, with unsafe terminal
controls removed and recognized sensitive markers redacted. The stored answer
preview SHALL be bounded to 16,000 characters with explicit truncation metadata.
Distinct tool and file evidence lists SHALL be capped at 200 items each.

#### Scenario: Untrusted fields contain unsafe or oversized text

- **WHEN** observation receives oversized tasks, answers, file paths, or text containing recognized credential markers or terminal controls
- **THEN** display previews are bounded and sanitized
- **AND** raw arguments, output, patch contents, and transport errors are not copied into display records

#### Scenario: File evidence is derived from successful inspection

- **WHEN** file listing, search, or a valid file read succeeds
- **THEN** observation retains bounded file-path previews without matched source text
- **AND** failed inspections do not contribute successful-file evidence

### Requirement: Tool-output truncation remains visible

A completed tool row SHALL retain its truncation flag. When truncation details
validate locally, the row SHALL retain only reason, limit, and observed count.
Additional metadata SHALL NOT enter the display record. Absent or invalid details
SHALL preserve a generic truncation warning.

#### Scenario: Truncated output has valid details

- **WHEN** a tool result is truncated by byte, line, or result limit with valid numeric details
- **THEN** its completion row displays the flag, reason, limit, and observed count for that call

#### Scenario: Details are absent or invalid

- **WHEN** a result is marked truncated without valid details
- **THEN** the row still displays `truncated=true` without fabricated details
- **AND** a following non-truncated call does not inherit that warning

### Requirement: Sampled timing freezes at settlement

Observation SHALL derive start time from injected wall-clock samples and
non-negative, non-decreasing elapsed duration from monotonic samples. Duration
SHALL freeze at settlement before answer fallback or result output. Only
operational events and settlement SHALL update elapsed time; answer events
SHALL NOT update it, and no timer SHALL run. After a clock-sample failure,
timing SHALL be shown as unavailable, not as measured fallback values.

#### Scenario: Wall clock moves backward

- **WHEN** wall-clock time changes while monotonic samples advance
- **THEN** elapsed duration continues to derive from monotonic samples and never becomes negative

#### Scenario: Output happens after settlement

- **WHEN** answer or result printing takes additional time after the session settles
- **THEN** the record's elapsed duration remains the value frozen at settlement

#### Scenario: Clock throws or supplies a non-finite value

- **WHEN** a clock sample is unavailable at creation or during a run
- **THEN** the record still exists and can settle, a safe timing diagnostic may be emitted, and timing is labelled `unavailable`

### Requirement: Terminal presentation is textual

The terminal SHALL display a header with run number, safe task preview, and local
start time; numbered event rows; and a separate activity/elapsed line. Interactive
terminals SHALL replace the activity line; non-TTY output SHALL use durable text
lines without cursor controls. Status meaning SHALL NOT depend on color.

#### Scenario: Non-interactive terminal output

- **WHEN** a turn runs with non-TTY output
- **THEN** the header, event feed, activity, and result remain understandable as plain text with no color or cursor dependency

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

### Requirement: Patch display does not grant consent

Observation SHALL distinguish preparation, waiting, approval, denial, abort,
conflict, and confirmed application using runtime evidence. Patch trails SHALL
preserve each call's progression. The trusted terminal approver SHALL retain
exclusive ownership of approval input and the complete exact diff. Only its
existing explicit consent may authorize application; display state SHALL NOT
approve a patch or infer whole-run cancellation from a patch approval abort.

#### Scenario: Waiting for an exact patch decision

- **WHEN** a patch requests approval
- **THEN** the run remains running with approval activity and the existing complete diff and explicit approval prompt are shown
- **AND** input belongs to that approval request rather than a new model task

#### Scenario: Decision and application differ

- **WHEN** approval is denied, aborted, followed by a conflict, or followed by confirmed application
- **THEN** observation records that actual trail without claiming application merely from approval

### Requirement: Observation has no execution authority

Observation, rendering, projection, answer-observer, diagnostic, and clock
failures SHALL be isolated from runtime execution, model transcript, permissions,
and patch consent. The projection SHALL NOT authorize tools, apply patches,
alter budgets, or mutate the conversation. Failure in one display consumer
SHALL NOT prevent other applicable consumers from receiving the runtime event.

#### Scenario: Display and diagnostic writers fail

- **WHEN** projection, rendering, answer observation, or diagnostic output throws
- **THEN** the underlying turn retains its runtime outcome and transcript
- **AND** no new execution authority or approval is created

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
