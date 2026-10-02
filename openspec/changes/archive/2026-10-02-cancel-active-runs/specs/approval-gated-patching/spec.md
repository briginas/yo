# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
