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
import { parseCliCommand, USAGE } from './cli-command.ts'
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

export type CliDependencies = {
    transport: ModelTransport
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

    let workspaceRoot: string

    try {
        workspaceRoot = await canonicalizeWorkspaceRoot(parsed.command.cwd)
    } catch (error) {
        const cause = error instanceof Error ? error.message : 'Unknown workspace error'

        return runtimeError(`Cannot use workspace: ${cause}`, writeError)
    }

    if (parsed.command.name === 'chat') {
        return runtimeError('Chat input loop is not available yet', writeError)
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
