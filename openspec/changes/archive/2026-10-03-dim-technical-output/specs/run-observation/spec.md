# Spec Delta

## ADDED Requirements

### Requirement: Technical output has subordinate visual weight

Supported interactive chat terminals SHALL dim operational headers, activity,
events, summaries, lists, and local diagnostics. Model answers, retained answer
previews, input prompts, and exact patch review SHALL keep normal intensity.
Every technical message SHALL reset intensity before subsequent output.
Non-interactive chat, non-empty `NO_COLOR`, and `TERM=dumb` SHALL use plain text.
Meaning SHALL remain readable without styling.

#### Scenario: Answer alongside technical output

- **WHEN** a supported interactive chat emits events, confirmed answer text, and a result card
- **THEN** technical messages are dimmed and reset independently while answer text retains its normal terminal color and intensity
- **AND** streaming and completed-answer fallback still print the answer once

#### Scenario: Retained answer inspection

- **WHEN** a user inspects a settled run with `/run N` in a supported interactive chat
- **THEN** headers, events, labels, truncation notices, and the result card are dimmed while the retained answer text has normal intensity
- **AND** absent answers are represented by a dimmed technical placeholder

#### Scenario: Plain output requested or required

- **WHEN** chat is non-interactive, `NO_COLOR` is non-empty, or `TERM` equals `dumb`
- **THEN** presentation adds no styling sequences and preserves existing plain text

#### Scenario: Cancellation and patch review

- **WHEN** a turn is cancelled or requests exact patch approval after technical output
- **THEN** cancelled status remains dimmed while the next input prompt and complete patch preview retain normal intensity
- **AND** formatting changes no cancellation, input ownership, or consent behavior
