# Project Instructions

## Collaboration

- Before every change, explain briefly what will be created or modified, why it is needed in the agent harness, and how it relates to the `pi` reference project.
- Build the project in small, independently verifiable steps. Complete and verify one milestone before starting the next.
- Keep explanations in plain language. Introduce a concept before relying on it in code.
- Add comments only for non-obvious rationale, invariants, safety boundaries, or edge cases. Do not restate the code, and update comments when behavior changes.
- Use `type` declarations rather than `interface` declarations.

## Resuming work

- Before proposing or making changes, read `PRD.md` and `IMPLEMENTATION_PLAN.md`.
- Inspect `git status --short` and recent commits to confirm the current repository state.
- Treat the first incomplete leaf item in `IMPLEMENTATION_PLAN.md` as the next candidate milestone.
- Confirm the bounded milestone with the user before implementation.
- Mark a plan item complete only after its scoped checks pass and the result is reviewed.

## Scope Discipline

- Do not add code, dependencies, API keys, runtime configuration, or broader capabilities unless the current milestone explicitly requires them.
- Prefer the smallest safe implementation that satisfies the current PRD acceptance criteria.
- Treat all filesystem, process, network, credential, and external-service actions as permissioned capabilities of the harness, not as implicit model privileges.
