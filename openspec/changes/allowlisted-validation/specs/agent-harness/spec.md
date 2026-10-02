# Spec Delta

Unapproved validation proposal; rebase against completed cancellation/rerun changes before implementation.

## MODIFIED Requirements

### Requirement: Closed model capability boundary

The harness SHALL expose only `list_files`, `search_code`, `read_file`,
`propose_patch`, and `run_validation` to the model. Model arguments SHALL remain untrusted until the
selected strict schema validates them. Unknown properties SHALL be rejected.
The only process tool SHALL be fixed allowlisted validation as specified in
`allowlisted-validation`. The model SHALL NOT receive direct filesystem access,
arbitrary write, general process/shell, network, credential, environment-reading,
or connector tools. Trusted
OAuth and provider requests SHALL remain outside this tool registry.

#### Scenario: Unsupported capability request

- **WHEN** the model requests an unknown tool, including a shell or general write tool
- **THEN** the dispatcher returns `unknown_tool` without executing that capability

#### Scenario: Invalid known-tool arguments

- **WHEN** a known tool receives malformed arguments or unknown properties
- **THEN** it returns `invalid_arguments` before filesystem execution
