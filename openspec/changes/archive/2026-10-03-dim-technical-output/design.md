# Design

## Context

See [proposal.md](proposal.md) for motivation and authorization. `cli.ts` supplies
separate answer, status, output, and error writers to `cli-app.ts`. Chat composes
`terminal-renderer.ts` for confirmed answer delivery and `terminal-observation.ts`
for operational display. Inspection currently combines technical evidence and the
retained answer into one plain string. Current text and lifecycle behavior must
survive unchanged when styling is disabled.

## Goals / Non-Goals

**Goals:** Add optional presentation formatting to chat output while preserving
all answer bytes, sequential execution, retained records, and consent boundaries.

**Non-Goals:** No runtime changes, themes, dependencies, extra flags, or changes to
the allowlisted-validation draft. Authentication commands remain outside chat
styling. Exact patch previews and input prompts retain normal intensity.

## Decisions

Use a small technical-text formatter owned by the terminal presentation layer.
The native entrypoint enables it only for interactive chat, unless a non-empty
`NO_COLOR` or `TERM=dumb` disables it. It wraps non-empty technical text with ANSI
dim (`2m`) and normal intensity (`22m`), without changing foreground color.
Tests and custom adapters default to identity formatting. A full theme system
would exceed this bounded cosmetic step.

Chat applies the formatter to status, result, list, and diagnostic writes. It
leaves the answer and patch-review writers unchanged. Inspection applies the same
formatter to technical sections before joining them with the plain retained
answer; it must not infer answer boundaries by searching for labels in text.
This preserves answers containing strings such as `Evidence:` or `Retained answer:`.

`pi` keeps styling in interactive components and its theme module
(`packages/coding-agent/src/modes/interactive/theme/theme.ts`), separate from
agent execution. This follows that separation with one formatter; it does not
adopt pi's TUI, theme loader, Markdown renderer, or dependencies.

## Risks / Trade-offs

- Dim support and appearance vary by terminal → retain complete textual labels;
  provide the plain-text escape hatch and test exact reset placement.
- Styling a combined inspection could dim the answer → format structured sections
  before joining; test multiline answers containing technical-looking labels.
- A reset omitted during cancellation could dim the next prompt → use self-contained
  formatted writes, never a persistent terminal mode; test completion and cancellation.
- Cosmetic changes could affect answer or consent flow → focused CLI tests check
  normal answer and exact diff output, followed by existing full regression checks.

## Migration Plan

One confirmed implementation leaf covers the formatter, wiring, inspection
formatting, and focused checks. Run spec validation, tests, build, formatting, and
diff checks; record review evidence. Rebuild the CLI to use the new presentation.
Reverting the presentation edits restores existing output without data migration.
The user accepted the working result on 2026-10-03 and authorized synchronization
and archival. [Verification](verification.md) records the completed closure.
