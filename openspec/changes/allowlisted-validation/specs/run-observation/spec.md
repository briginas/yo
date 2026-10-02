# Spec Delta

Unapproved validation proposal; rebase against completed cancellation/rerun changes before implementation.

## MODIFIED Requirements

### Requirement: Observation retains bounded safe display data

Observation SHALL retain summaries rather than raw tool arguments, tool output,
transport payloads, credentials, hidden reasoning, or patch contents. Task and
file previews SHALL be bounded to 160 Unicode characters, with unsafe terminal
controls removed and recognized sensitive markers redacted. The stored answer
preview SHALL be bounded to 16,000 characters with explicit truncation metadata.
Distinct tool and file evidence lists SHALL be capped at 200 items each.
For validation only, observation SHALL additionally retain the bounded sanitized
diagnostic tail from its structured result, capped at 2,000 lines and 50 KiB,
with truncation metadata; it SHALL NOT copy unrestricted process output.

#### Scenario: Untrusted fields contain unsafe or oversized text

- **WHEN** observation receives oversized tasks, answers, file paths, or text containing recognized credential markers or terminal controls
- **THEN** display previews are bounded and sanitized
- **AND** raw arguments, output, patch contents, and transport errors are not copied into display records

#### Scenario: File evidence is derived from successful inspection

- **WHEN** file listing, search, or a valid file read succeeds
- **THEN** observation retains bounded file-path previews without matched source text
- **AND** failed inspections do not contribute successful-file evidence

## ADDED Requirements

### Requirement: Validation outcome display is grounded per call

The feed and result card SHALL show each validation identifier, outcome,
available exit code, and bounded sanitized diagnostics once per call.
Test/build failure SHALL be distinct from executor failure. One-line active
status SHALL contain only the validated enum or `arguments=unavailable`, not
process output. Display failures SHALL NOT alter results, transcript, or consent.

#### Scenario: Mixed validation results

- **WHEN** test passes and build fails with exit 2
- **THEN** the feed and result card retain each call's actual outcome and build diagnostics without treating the entire run as necessarily failed

#### Scenario: Invalid or unsafe process metadata

- **WHEN** events contain unvalidated arguments, environment, temporary paths, raw spawn options, process identifiers, or unsafe error objects
- **THEN** display retains only locally validated safe fields and never prints those raw values

#### Scenario: Failed rendering

- **WHEN** validation display throws
- **THEN** the loop retains its single result and continues with unchanged permissions and transcript
