# Project Instructions

## Collaboration

- Before every change, explain briefly what will be created or modified, why it is needed in the agent harness, and how it relates to the `pi` reference project.
- Build the project in small, independently verifiable steps. Complete and verify one milestone before starting the next.
- Keep explanations in plain language. Introduce a concept before relying on it in code.
- When proposing an implementation plan, first provide a detailed plain-language walkthrough: explain the current behavior, the target behavior, the role of each affected component, the execution or data flow, scope boundaries, risks, validation, and what remains deferred.
- Include a Mermaid diagram when control flow, data flow, component interaction, or a before/after comparison becomes materially easier to understand visually. Do not force a diagram for a simple single-step change.
- Relate the proposed design to the corresponding `pi` implementation where relevant, while preserving the smaller approved scope of this project.
- Add comments only for non-obvious rationale, invariants, safety boundaries, or edge cases. Do not restate the code, and update comments when behavior changes.
- Use `type` declarations rather than `interface` declarations.

## Resuming work

- Before proposing or making changes, read `PRD.md` and
  `IMPLEMENTATION_PLAN.md`. Treat them as maps to the detailed source-of-truth
  documents, not as complete specifications.
- For work on the active milestone, follow the links in those maps and read its
  requirements and active implementation plan before proposing or making
  changes.
- Read completed milestone documents only when the task concerns historical
  behavior, regression, or compatibility with that milestone.
- Inspect `git status --short` and recent commits to confirm the current repository state.
- Treat the first incomplete leaf item in the linked active implementation plan
  as the next candidate milestone.
- Confirm the bounded milestone with the user before implementation.
- Mark a plan item complete only after its scoped checks pass and the result is reviewed.

## Scope Discipline

- Do not add code, dependencies, API keys, runtime configuration, or broader capabilities unless the current milestone explicitly requires them.
- Prefer the smallest safe implementation that satisfies the acceptance
  criteria in the linked active milestone requirements.
- Treat all filesystem, process, network, credential, and external-service actions as permissioned capabilities of the harness, not as implicit model privileges.
