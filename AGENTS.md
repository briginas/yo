# Project Instructions

## Collaboration

- Before every change, explain briefly what will be created or modified, why it is needed in the agent harness, and how it relates to the `pi` reference project.
- Build the project in small, independently verifiable steps. Complete and verify one milestone before starting the next.
- Keep explanations in plain language. Introduce a concept before relying on it in code.
- Use `type` declarations rather than `interface` declarations.

## Scope Discipline

- Do not add code, dependencies, API keys, runtime configuration, or broader capabilities unless the current milestone explicitly requires them.
- Prefer the smallest safe implementation that satisfies the current PRD acceptance criteria.
- Treat all filesystem, process, network, credential, and external-service actions as permissioned capabilities of the harness, not as implicit model privileges.
