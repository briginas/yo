# Proposal

## Why

Model answers and operational chat output currently have the same visual weight.
The user requested dimmer technical messages while preserving the answer's normal
terminal color.

## What Changes

- Dim chat headers, activity, events, result cards, run lists, and local diagnostics
  in supported interactive terminals; reset intensity after every formatted message.
- Keep live and completed answers, retained answer previews, input prompts, and
  exact patch review text at normal intensity.
- Preserve plain output for non-interactive sessions, non-empty `NO_COLOR`, and
  `TERM=dumb`.
- Acceptance: technical output is visibly subordinate, answer bytes and runtime
  behavior are unchanged, and formatting cannot leak into subsequent output.
- Deferred: themes, configurable colors, Markdown rendering, and all validation
  draft work.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `run-observation`: optional dim technical presentation alongside normal answer
  presentation, including retained inspection.

## Impact

Only trusted CLI presentation and focused tests change. No runtime permission,
provider, transcript, dependency, or model-visible tool changes are required.
The user's 2026-10-03 instruction "давай, лучше затемним технические сообщения.
а цвет ответа модели оставим как есть" authorizes this bounded implementation.
It supersedes the earlier proposed cyan answer. Result acceptance and specification
synchronization remain subject to user review.
