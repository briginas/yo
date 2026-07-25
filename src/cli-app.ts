import { relative, resolve, sep } from 'node:path'

import {
    createOpenAICodexAuthorization,
    exchangeOpenAICodexAuthorizationCode,
    startOpenAICodexCallbackListener,
    type OpenAICodexAuthorization,
    type OpenAICodexCallbackListener,
    type OpenAICodexCallbackListenerOptions,
    type OpenAICodexCredentialExchange,
} from './auth/openai-codex-login.ts'
import { createFileCredentialStore } from './auth/file-credential-store.ts'
import { OPENAI_CODEX_PROVIDER_ID, type CredentialStore } from './auth/credential.ts'
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

const USAGE = [
    'Usage: yo ask "<task>" --cwd <workspace> [--model <name>]',
    '       yo login',
    '       yo auth status',
    '       yo logout',
].join('\n')

type AskCommand = {
    name: 'ask'
    task: string
    cwd: string
    model: string | null
}

type LoginCommand = {
    name: 'login'
}

type AuthStatusCommand = {
    name: 'auth_status'
}

type LogoutCommand = {
    name: 'logout'
}

type CliCommand = AskCommand | LoginCommand | AuthStatusCommand | LogoutCommand

type ParseResult =
    | {
          status: 'success'
          command: CliCommand
      }
    | {
          status: 'error'
          message: string
      }

export type CliDependencies = {
    transport: ModelTransport | null
    writeOutput: (message: string) => void
    writeError: (message: string) => void
    createAuthorization?: () => OpenAICodexAuthorization
    startCallbackListener?: (
        options: OpenAICodexCallbackListenerOptions
    ) => Promise<OpenAICodexCallbackListener>
    exchangeCredential?: OpenAICodexCredentialExchange
    credentialStore?: CredentialStore
}

export type CliResult = {
    exitCode: 0 | 1 | 2
    session: SessionState | null
}

const parseCliCommand = (argv: readonly string[]): ParseResult => {
    if (argv[0] === 'login') {
        if (argv.length !== 1) {
            return {
                status: 'error',
                message: 'login does not accept arguments',
            }
        }

        return {
            status: 'success',
            command: { name: 'login' },
        }
    }

    if (argv[0] === 'auth') {
        if (argv[1] !== 'status') {
            return {
                status: 'error',
                message: 'Expected the auth status command',
            }
        }

        if (argv.length !== 2) {
            return {
                status: 'error',
                message: 'auth status does not accept arguments',
            }
        }

        return {
            status: 'success',
            command: { name: 'auth_status' },
        }
    }

    if (argv[0] === 'logout') {
        if (argv.length !== 1) {
            return {
                status: 'error',
                message: 'logout does not accept arguments',
            }
        }

        return {
            status: 'success',
            command: { name: 'logout' },
        }
    }

    if (argv[0] !== 'ask') {
        return {
            status: 'error',
            message: 'Expected the ask, login, auth status, or logout command',
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
            name: 'ask',
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

const isAddressInUseError = (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'

type LoginDependencies = {
    createAuthorization: (() => OpenAICodexAuthorization) | undefined
    startCallbackListener:
        | ((options: OpenAICodexCallbackListenerOptions) => Promise<OpenAICodexCallbackListener>)
        | undefined
    exchangeCredential: OpenAICodexCredentialExchange
    credentialStore: CredentialStore
    writeError: CliDependencies['writeError']
    writeOutput: CliDependencies['writeOutput']
}

const runLogin = async ({
    createAuthorization,
    startCallbackListener,
    exchangeCredential,
    credentialStore,
    writeError,
    writeOutput,
}: LoginDependencies): Promise<CliResult> => {
    const authorization = createAuthorization?.() ?? createOpenAICodexAuthorization()
    let listener: OpenAICodexCallbackListener

    try {
        listener = await (startCallbackListener ?? startOpenAICodexCallbackListener)({
            expectedState: authorization.state,
        })
    } catch (error) {
        if (isAddressInUseError(error)) {
            return runtimeError(
                'OAuth callback address 127.0.0.1:1455 is already in use. Close the other listener and try again.',
                writeError
            )
        }

        return runtimeError('Cannot start the OAuth callback listener.', writeError)
    }

    try {
        writeOutput(`Open this URL in your browser:\n${authorization.authorizationUrl}`)

        const outcome = await listener.waitForCallback()

        if (outcome === null) {
            return runtimeError('OAuth callback did not complete.', writeError)
        }

        if (outcome.status === 'rejected') {
            return runtimeError(
                outcome.reason === 'state_mismatch'
                    ? 'OAuth callback state did not match the login request.'
                    : 'OAuth callback did not include an authorization code.',
                writeError
            )
        }

        try {
            const credential = await exchangeCredential({
                code: outcome.code,
                codeVerifier: authorization.codeVerifier,
            })

            await credentialStore.modify(OPENAI_CODEX_PROVIDER_ID, async () => credential)
        } catch {
            return runtimeError('OAuth credential exchange failed. Run yo login again.', writeError)
        }

        writeOutput('Signed in successfully.')

        return {
            exitCode: 0,
            session: null,
        }
    } finally {
        await listener.close()
    }
}

const runAuthStatus = async ({
    credentialStore,
    writeError,
    writeOutput,
}: Pick<
    LoginDependencies,
    'credentialStore' | 'writeError' | 'writeOutput'
>): Promise<CliResult> => {
    let credential: Awaited<ReturnType<CredentialStore['read']>>

    try {
        credential = await credentialStore.read(OPENAI_CODEX_PROVIDER_ID)
    } catch {
        return runtimeError('Cannot read OAuth authentication status.', writeError)
    }

    if (credential === undefined) {
        writeOutput('Not signed in. Run yo login.')
    } else {
        writeOutput(
            [
                'Authentication: signed in',
                `Provider: ${OPENAI_CODEX_PROVIDER_ID}`,
                `Account ID: ${credential.accountId}`,
                `Expires at: ${new Date(credential.expiresAt).toISOString()}`,
                `Access token: ${credential.expiresAt > Date.now() ? 'valid' : 'expired'}`,
            ].join('\n')
        )
    }

    return {
        exitCode: 0,
        session: null,
    }
}

const runLogout = async ({
    credentialStore,
    writeError,
    writeOutput,
}: Pick<
    LoginDependencies,
    'credentialStore' | 'writeError' | 'writeOutput'
>): Promise<CliResult> => {
    try {
        await credentialStore.delete(OPENAI_CODEX_PROVIDER_ID)
    } catch {
        return runtimeError('Cannot remove OAuth credential.', writeError)
    }

    writeOutput('Signed out of OpenAI Codex.')

    return {
        exitCode: 0,
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
    {
        transport,
        writeOutput,
        writeError,
        createAuthorization,
        startCallbackListener,
        exchangeCredential,
        credentialStore,
    }: CliDependencies
): Promise<CliResult> => {
    const parsed = parseCliCommand(argv)

    if (parsed.status === 'error') {
        return usageError(parsed.message, writeError)
    }

    if (parsed.command.name === 'login') {
        return runLogin({
            createAuthorization,
            startCallbackListener,
            exchangeCredential: exchangeCredential ?? exchangeOpenAICodexAuthorizationCode,
            credentialStore: credentialStore ?? createFileCredentialStore(),
            writeOutput,
            writeError,
        })
    }

    if (parsed.command.name === 'auth_status') {
        return runAuthStatus({
            credentialStore: credentialStore ?? createFileCredentialStore(),
            writeOutput,
            writeError,
        })
    }

    if (parsed.command.name === 'logout') {
        return runLogout({
            credentialStore: credentialStore ?? createFileCredentialStore(),
            writeOutput,
            writeError,
        })
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
