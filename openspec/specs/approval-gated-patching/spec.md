# Approval-gated patching Specification

## Purpose

Define the implemented Milestone 3 boundary for exact edits to one existing
workspace file. The model proposes data; trusted harness code validates,
prepares, obtains consent, revalidates, and applies. It follows pi's exact-edit
and diff mechanics with a smaller permission boundary: no fuzzy matching,
general write tool, or implicit mutation authority.

## Requirements

### Requirement: Strict bounded proposal arguments

`propose_patch` SHALL accept one non-empty `path` and 1–20 edits containing only
non-empty `oldText` and string `newText`. The strict schema SHALL reject unknown
properties and combined edit-text size above 50 KiB of UTF-8 bytes. Empty
`newText` SHALL be allowed for an exact deletion of matched text. Validation
SHALL precede proposal preparation or mutation.

#### Scenario: Invalid proposal

- **WHEN** arguments contain an extra property, no edits, more than 20 edits, empty old text, or excessive edit bytes
- **THEN** the call returns `invalid_arguments` without preparing or writing a patch

### Requirement: Existing eligible single-file target

Preparation and application SHALL independently authorize exactly one existing
regular file inside the canonical workspace. They SHALL reject lexical or
canonical escapes, sensitive paths, symlinks in any path component, missing
targets, and non-regular targets. Model-visible patching SHALL NOT create,
delete, rename, move, or chmod files, perform arbitrary full-file writes, or
apply multi-file transactions. Temporary-file replacement and mode preservation
are internal application mechanics, not additional model capabilities.

#### Scenario: Unsafe target

- **WHEN** a target is sensitive, outside the workspace, missing, a symlink, or not a regular file
- **THEN** preparation denies the call without mutation

### Requirement: Exact transform against one original

The transform SHALL require valid UTF-8 text without NUL in source or edit
content. Every old-text range SHALL match exactly once against the same original
after line-ending normalization; ranges SHALL NOT overlap or nest. Fuzzy
whitespace matching and incremental matching against earlier edit results SHALL
NOT be used. Missing, ambiguous, duplicate, overlapping, and unchanged proposals
SHALL be rejected. Output SHALL preserve the source UTF-8 BOM and dominant
line-ending style.

#### Scenario: Disjoint replacements

- **WHEN** two edits uniquely match disjoint ranges of the original file
- **THEN** both replacements are computed from that original, regardless of text introduced by the other edit

#### Scenario: Ambiguous or unchanged replacement

- **WHEN** old text matches more than once, overlaps another edit, or the combined result is unchanged
- **THEN** the call fails without requesting application

### Requirement: Complete bounded immutable preview

Source and resulting content SHALL each be at most 1 MiB. Both display and
unified previews SHALL be bounded to 50 KiB; an oversized preview SHALL be
rejected rather than truncated for approval. Trusted preparation SHALL create
an immutable in-memory proposal with identifier, canonical relative path,
source and next-content hashes, edits, resulting content, preserved mode, and
complete diffs. Approval SHALL bind to that precise proposal, not a mutable
model argument object. Proposal state SHALL NOT be persisted.

#### Scenario: Oversized diff

- **WHEN** the complete diff exceeds its byte limit
- **THEN** the proposal is rejected; no shortened diff is offered for consent

#### Scenario: Observer or caller mutation

- **WHEN** an observer or approval callback attempts to change the exposed proposal view
- **THEN** the approved source and result remain the immutable prepared proposal

### Requirement: Explicit terminal consent for each proposal

The terminal SHALL clear progress, show the canonical relative path and full
diff with added and removed lines, and ask `Apply this patch? [y/N]`. Only a
line whose trimmed case-insensitive value is `y` or `yes` SHALL approve.
Blank or other input, EOF, input failure, an absent approver, or non-interactive
input SHALL deny without applying. Non-TTY output MAY display the complete
preview but SHALL NOT read chat input as approval. Approval SHALL NOT carry to
another proposal or be inferred from path eligibility, observation commands,
or prior consent.

#### Scenario: Explicit approval

- **WHEN** interactive approval receives a line containing `YES` with surrounding whitespace
- **THEN** only the displayed proposal proceeds to revalidation

#### Scenario: Nonaffirmative or unavailable approval

- **WHEN** approval is unavailable or receives blank input, `/runs`, `/run 1`, or EOF
- **THEN** the patch is denied and the target is unchanged

### Requirement: Revalidate exact approved state before writing

Immediately before application, trusted code SHALL repeat path policy and
regular-file checks, verify target identity and mode, reread bounded source
bytes, and compare the source hash. It SHALL recompute the transform and verify
next hash, content, and both diffs against the approved proposal. Changed source
SHALL yield `base_changed`; changed proposal properties SHALL yield
`proposal_changed`. A conflict SHALL leave the newer target untouched; a new
proposal SHALL require new consent. These checks SHALL NOT be described as
cross-process compare-and-swap or transactional isolation: a residual filesystem
race remains between checking and replacement.

#### Scenario: Source changes during review

- **WHEN** the source differs from the approved base before application
- **THEN** the call returns a conflict without overwriting the changed file

### Requirement: Atomic trusted replacement

Application SHALL create a unique exclusive temporary file in the target
directory, preserve the approved mode, write the exact approved content, flush
and close it, and atomically rename it over the target. Preparation, denial,
conflict, and failed pre-rename work SHALL leave the target unchanged. Temporary
cleanup SHALL be best effort and SHALL NOT broaden the authorized mutation.

#### Scenario: Successful application

- **WHEN** consent and revalidation succeed and I/O completes
- **THEN** the target contains exactly the approved bytes with preserved mode, BOM, and line endings

#### Scenario: Temporary write failure

- **WHEN** temporary write, flush, close, or rename fails before replacement completes
- **THEN** the target is not partially written and cleanup is attempted with a sanitized failure result

### Requirement: Separate review time and settled mutation timeout

Preparation and application SHALL each use the configured tool execution
timeout; waiting for human approval SHALL be outside that timeout. Application
timeout SHALL abort and await outstanding I/O before returning, check the signal
before rename, and avoid a detached write completing after a timeout result.
If an already initiated rename succeeds, the outcome SHALL remain applied even
if the timeout fired while rename was settling. An approver reporting `aborted`
SHALL prevent application. Trusted run cancellation SHALL also stop preparation, pending approval, and
application through their settled boundaries, independently of review timeout.
The first observed timeout/cancellation cause SHALL determine a stopped tool
result; a successful rename SHALL still retain applied success.

#### Scenario: Timeout during temporary I/O

- **WHEN** timeout fires before the pre-rename abort check
- **THEN** I/O settles, rename is skipped, cleanup is attempted, and only then is timeout returned

### Requirement: Structured patch outcomes and isolated evidence

Each patch call SHALL produce exactly one terminal tool result: `success` for
application, `denied` for policy or consent refusal, `invalid_arguments` for
schema or transform rejection, `timeout`, `aborted`, or `execution_error` for
conflict or sanitized I/O failure. Conflicts SHALL retain their machine-readable
code. Ordered lifecycle evidence SHALL distinguish prepared, approval requested,
approval resolved, conflicted, and applied. Path eligibility and human approval
SHALL remain separate decisions. Lifecycle metadata SHALL exclude full diffs,
source content, unknown arguments, and credentials; the complete diff belongs
only in the explicit approval view.

#### Scenario: Denial followed by recovery

- **WHEN** the user denies a patch
- **THEN** the model receives one denied result and may inspect or propose again, with fresh consent required for any later proposal

### Requirement: Conversation integration without stored consent

The loop SHALL await the resolved patch call before continuing. Chat SHALL
retain its structured call and result, but SHALL NOT retain a pending approval
or insert the approval response into model context. Read tools, final-answer
delivery, and OAuth behavior SHALL remain available. No validation commands,
automatic repair, rollback, Git operations, deployment, or external communication
SHALL be introduced by patch application.

#### Scenario: Later chat turn

- **WHEN** a patch call has completed and the user sends a follow-up
- **THEN** the conversation includes the patch result without any reusable approval authority

### Requirement: Cancellation releases exact patch review

Cancellation during preparation or review SHALL prevent application, await
owned work, and invalidate pending consent. A cancelled pending approval SHALL
resolve as aborted. Late affirmative input SHALL NOT revive that proposal or
enter a subsequent task. Consent and path authorization SHALL remain separate,
and a later proposal SHALL require fresh complete-diff review and consent.

#### Scenario: Cancellation during preparation

- **WHEN** cancellation arrives while preparing a patch
- **THEN** preparation and cleanup settle without a new approval prompt or workspace mutation

#### Scenario: Cancellation wins approval race

- **WHEN** cancellation occurs before a pending affirmative approval is accepted
- **THEN** approval resolves aborted, the tool has one aborted result, and late consent cannot apply or be reused

#### Scenario: Approval arrives before cancellation

- **WHEN** consent resolves approved but cancellation is observed before application begins
- **THEN** the signal check prevents mutation and the run cannot reuse that consent later

### Requirement: Cancellation respects committed replacement

Before rename starts, cancellation SHALL prevent replacement and await
outstanding temporary I/O and cleanup. Once rename starts, its outcome SHALL
be awaited. Successful rename SHALL retain success and applied evidence even
if the run then settles cancelled. Cancellation SHALL NOT undo any applied
patch or authorize an additional filesystem operation beyond existing cleanup.

#### Scenario: Temporary write is pending

- **WHEN** cancellation arrives during temporary-file writing before rename
- **THEN** writing and cleanup settle, rename is skipped, and the target remains unchanged

#### Scenario: Rename succeeds after cancellation request

- **WHEN** cancellation arrives after rename begins and rename succeeds
- **THEN** the patch tool returns success with applied evidence, the target contains approved bytes, and the run may settle cancelled without rollback

#### Scenario: Rename fails during cancellation

- **WHEN** an already-started rename rejects while cancellation is pending
- **THEN** its settled failure is recorded safely with cleanup and no applied evidence is fabricated
