import { relative, resolve, sep } from 'node:path'

import {
    canonicalizeWorkspaceRoot,
    readFileArgumentsSchema,
    runAgent,
    type ModelTransport,
    type SessionState,
    type ToolCall,
    type ToolResult,
} from './runtime/index.ts'

const RUN_BUDGET = {
    maxSteps: 10,
    perToolTimeoutMs: 5_000,
} as const

const USAGE = 'Usage: yo ask "<task>" --cwd <workspace> [--model <name>]'

type AskCommand = {
    task: string
    cwd: string
    model: string | null
}

type ParseResult =
    | {
          status: 'success'
          command: AskCommand
      }
    | {
          status: 'error'
          message: string
      }

export type CliDependencies = {
    transport: ModelTransport | null
    writeOutput: (message: string) => void
    writeError: (message: string) => void
}

export type CliResult = {
    exitCode: 0 | 1 | 2
    session: SessionState | null
}

const parseAskCommand = (argv: readonly string[]): ParseResult => {
    if (argv[0] !== 'ask') {
        return {
            status: 'error',
            message: 'Expected the ask command',
        }
    }

    let task: string | undefined
    let cwd: string | undefined
    let model: string | undefined

    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index]!

        if (argument === '--cwd' || argument === '--model') {
            const value = argv[index + 1]

            if (value === undefined || value.startsWith('-') || value.trim().length === 0) {
                return {
                    status: 'error',
                    message: `${argument} requires a non-empty value`,
                }
            }

            if (argument === '--cwd') {
                if (cwd !== undefined) {
                    return {
                        status: 'error',
                        message: '--cwd may be specified only once',
                    }
                }

                cwd = value
            } else {
                if (model !== undefined) {
                    return {
                        status: 'error',
                        message: '--model may be specified only once',
                    }
                }

                model = value
            }

            index += 1
            continue
        }

        if (argument.startsWith('-')) {
            return {
                status: 'error',
                message: `Unknown option: ${argument}`,
            }
        }

        if (task !== undefined) {
            return {
                status: 'error',
                message: 'Expected exactly one task',
            }
        }

        task = argument
    }

    if (task === undefined || task.trim().length === 0) {
        return {
            status: 'error',
            message: 'Task must not be empty',
        }
    }

    if (cwd === undefined) {
        return {
            status: 'error',
            message: '--cwd is required',
        }
    }

    return {
        status: 'success',
        command: {
            task,
            cwd,
            model: model ?? null,
        },
    }
}

const usageError = (message: string, writeError: CliDependencies['writeError']): CliResult => {
    writeError(`${message}\n${USAGE}`)

    return {
        exitCode: 2,
        session: null,
    }
}

const runtimeError = (message: string, writeError: CliDependencies['writeError']): CliResult => {
    writeError(message)

    return {
        exitCode: 1,
        session: null,
    }
}

const addUnique = (values: string[], seen: Set<string>, value: string): void => {
    if (seen.has(value)) {
        return
    }

    seen.add(value)
    values.push(value)
}

const normalizeWorkspacePath = (workspaceRoot: string, requestedPath: string): string => {
    const normalizedPath = relative(workspaceRoot, resolve(workspaceRoot, requestedPath))

    return normalizedPath === '' ? '.' : normalizedPath.split(sep).join('/')
}

const collectFiles = (
    session: SessionState,
    call: ToolCall,
    result: Extract<ToolResult, { status: 'success' }>
): string[] => {
    if (call.name === 'list_files') {
        return result.content.split('\n').filter((path) => path.length > 0 && !path.endsWith('/'))
    }

    if (call.name === 'search_code') {
        return result.content
            .split('\n')
            .map((match) => /^(.*):\d+:/.exec(match)?.[1])
            .filter((path): path is string => path !== undefined)
    }

    if (call.name === 'read_file') {
        const parsedArguments = readFileArgumentsSchema.safeParse(call.arguments)

        if (parsedArguments.success) {
            return [normalizeWorkspacePath(session.workspaceRoot, parsedArguments.data.path)]
        }
    }

    return []
}

const formatSessionOutput = (session: SessionState): string => {
    const callsById = new Map<string, ToolCall>()
    const tools: string[] = []
    const seenTools = new Set<string>()
    const files: string[] = []
    const seenFiles = new Set<string>()

    for (const event of session.events) {
        if (event.type === 'tool_requested') {
            callsById.set(event.call.id, event.call)
            continue
        }

        if (event.type === 'tool_authorized' && event.decision.decision === 'allow') {
            const call = callsById.get(event.callId)

            if (call !== undefined) {
                addUnique(tools, seenTools, call.name)
            }

            continue
        }

        if (event.type === 'tool_completed' && event.result.status === 'success') {
            const call = callsById.get(event.result.callId)

            if (call === undefined) {
                continue
            }

            for (const file of collectFiles(session, call, event.result)) {
                addUnique(files, seenFiles, file)
            }
        }
    }

    return [
        session.finalAnswer ?? 'No final answer.',
        '',
        'Evidence:',
        `Stop reason: ${session.stopReason ?? 'unknown'}`,
        `Tools: ${tools.length > 0 ? tools.join(', ') : '(none)'}`,
        'Files:',
        ...(files.length > 0 ? files.map((file) => `- ${file}`) : ['- (none)']),
    ].join('\n')
}

export const runCli = async (
    argv: readonly string[],
    { transport, writeOutput, writeError }: CliDependencies
): Promise<CliResult> => {
    const parsed = parseAskCommand(argv)

    if (parsed.status === 'error') {
        return usageError(parsed.message, writeError)
    }

    if (transport === null) {
        return runtimeError(
            'OpenAI transport is not available yet; complete milestone 6 first.',
            writeError
        )
    }

    let workspaceRoot: string

    try {
        workspaceRoot = await canonicalizeWorkspaceRoot(parsed.command.cwd)
    } catch (error) {
        const cause = error instanceof Error ? error.message : 'Unknown workspace error'

        return runtimeError(`Cannot use workspace: ${cause}`, writeError)
    }

    try {
        const session = await runAgent({
            task: parsed.command.task,
            workspaceRoot,
            budget: RUN_BUDGET,
            model: parsed.command.model,
            transport,
        })

        writeOutput(formatSessionOutput(session))

        return {
            exitCode: session.status === 'completed' ? 0 : 1,
            session,
        }
    } catch (error) {
        const cause = error instanceof Error ? error.message : 'Unknown runtime error'

        return runtimeError(`Agent run failed: ${cause}`, writeError)
    }
}
