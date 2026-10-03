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
import { parseObservationCommand } from './observation-command.ts'
import { parseRerunCommand } from './rerun-command.ts'
import { createChatRunCatalog, type ChatRunReservation } from './chat-runs.ts'
import {
    createObservationSession,
    type ObservationClocks,
    type ObservationSessionOptions,
} from './observation-session.ts'
import {
    createTerminalObservationView,
    formatObservationDiagnostic,
    formatObservationCommand,
} from './terminal-observation.ts'
import { runChatInput, type LineInput } from './line-input.ts'
import {
    canonicalizeWorkspaceRoot,
    createConversation,
    runConversationTurn,
    type ModelTransport,
    type SessionState,
} from './runtime/index.ts'
import {
    createTerminalRenderer,
    createTerminalStatusOutput,
    type TerminalTextWriter,
} from './terminal-renderer.ts'
import { createTerminalPatchApprover } from './terminal-approval.ts'
import { createRunController, type RunController } from './runtime/run-controller.ts'
import { plainTerminalText, type TerminalTextFormatter } from './terminal-style.ts'

const RUN_BUDGET = {
    maxSteps: 10,
    perToolTimeoutMs: 5_000,
} as const

export type CliDependencies = {
    transport: ModelTransport
    observationClocks?: ObservationClocks
    observationProjectEvent?: ObservationSessionOptions['projectEvent']
    runTurn?: typeof runConversationTurn
    writeOutput: (message: string) => void
    writeError: (message: string) => void
    createLineInput?: () => LineInput
    subscribeProcessInterrupt?: (listener: () => void) => () => void
    writeAnswer?: TerminalTextWriter
    writeStatus?: TerminalTextWriter
    clearStatusLine?: () => void
    moveStatusCursorToStart?: () => void
    isInteractive?: boolean
    formatTechnical?: TerminalTextFormatter
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

type TerminalDependencies = {
    writeError: CliDependencies['writeError']
    writeAnswer: TerminalTextWriter
    writeStatus: TerminalTextWriter
    clearStatusLine: () => void
    moveStatusCursorToStart: () => void
    isInteractive: boolean
}

const createTerminalComposition = ({
    writeError,
    writeAnswer,
    writeStatus,
    clearStatusLine,
    moveStatusCursorToStart,
    isInteractive,
}: TerminalDependencies) => {
    const statusOutput = createTerminalStatusOutput({
        write: writeStatus,
        clearLine: clearStatusLine,
        moveCursorToStart: moveStatusCursorToStart,
        isInteractive,
    })
    const renderer = createTerminalRenderer({
        writeAnswer: (message) => {
            try {
                statusOutput.clearProgress()
            } catch {
                /* Answer delivery survives progress cleanup. */
            }
            writeAnswer(message)
        },
        writeStatus: () => undefined,
        writeError,
        isInteractive,
    })

    return {
        renderer,
        statusOutput,
    }
}

type ChatDependencies = TerminalDependencies & {
    transport: ModelTransport
    writeOutput: CliDependencies['writeOutput']
    createLineInput: () => LineInput
    observationClocks: ObservationClocks
    observationProjectEvent?: ObservationSessionOptions['projectEvent']
    runTurn: typeof runConversationTurn
    subscribeProcessInterrupt: (listener: () => void) => () => void
    formatTechnical: TerminalTextFormatter
}

type RunChatOptions = ChatDependencies & {
    workspaceRoot: string
    model: string | null
}

class ChatTurnError extends Error {}

const runChat = async ({
    workspaceRoot,
    model,
    transport,
    writeOutput: writePlainOutput,
    writeError: writePlainError,
    createLineInput,
    writeAnswer,
    writeStatus: writePlainStatus,
    clearStatusLine,
    moveStatusCursorToStart,
    isInteractive,
    observationClocks,
    observationProjectEvent,
    runTurn,
    subscribeProcessInterrupt,
    formatTechnical,
}: RunChatOptions): Promise<CliResult> => {
    const writeOutput = (message: string): void => writePlainOutput(formatTechnical(message))
    const writeError = (message: string): void => writePlainError(formatTechnical(message))
    const writeStatus = (message: string): void => writePlainStatus(formatTechnical(message))
    const { renderer, statusOutput } = createTerminalComposition({
        writeError,
        writeAnswer,
        writeStatus,
        clearStatusLine,
        moveStatusCursorToStart,
        isInteractive,
    })
    const observations = createObservationSession({
        clocks: observationClocks,
        ...(observationProjectEvent === undefined ? {} : { projectEvent: observationProjectEvent }),
        view: createTerminalObservationView(statusOutput, writeOutput),
        onRuntimeEvent: renderer.onEvent,
        diagnose: (diagnostic) => writeError(formatObservationDiagnostic(diagnostic)),
    })
    const runs = createChatRunCatalog()
    const writeRerunDiagnostic = (message: string): void => {
        try {
            writeOutput(message)
        } catch {
            try {
                writeError(formatObservationDiagnostic('rendering_failed'))
            } catch {
                // Diagnostic failures cannot turn a consumed control command into a task.
            }
        }
    }
    const clearProgress = (): void => {
        try {
            statusOutput.clearProgress()
        } catch {
            /* Terminal cleanup cannot own input or consent. */
        }
    }
    const initialConversation = createConversation({
        workspaceRoot,
        model,
    })
    let conversation = initialConversation
    let lastSession: SessionState | null = null
    let input: LineInput

    try {
        input = createLineInput()
    } catch {
        return runtimeError('Cannot start chat input.', writeError)
    }

    let active: RunController<Awaited<ReturnType<typeof runConversationTurn>>> | undefined
    let disposeInputInterrupt: (() => void) | undefined
    let disposeProcessInterrupt: (() => void) | undefined
    let inputStarted = false
    const onInterrupt = (): void => {
        if (active !== undefined) {
            const alreadyAborted = active.signal.aborted
            active.requestCancellation()
            if (!alreadyAborted && active.signal.aborted) {
                try {
                    input.discardUntilNextRead?.()
                } catch {
                    // Input reset failure cannot detach an unsettled turn.
                    input.close()
                }
            }
        } else {
            input.close()
        }
    }
    try {
        // Readline loses its key route on EOF/reset failure; protect unsettled work then too.
        disposeProcessInterrupt = subscribeProcessInterrupt(onInterrupt)
        if (isInteractive) disposeInputInterrupt = input.subscribeInterrupt?.(onInterrupt)
        inputStarted = true
        await runChatInput({
            input,
            clearProgress,
            onMessage: async (line, windowId) => {
                const command = parseObservationCommand(line)
                if (command.type !== 'message') {
                    try {
                        writePlainOutput(
                            formatObservationCommand(
                                command,
                                observations.getHistory(),
                                formatTechnical
                            )
                        )
                    } catch {
                        try {
                            writeError(formatObservationDiagnostic('rendering_failed'))
                        } catch {
                            // A consumed local command must never fall through to model submission.
                        }
                    }
                    return
                }
                const rerunCommand = parseRerunCommand(line)
                if (rerunCommand.type === 'invalid') {
                    writeRerunDiagnostic('Usage: /rerun N (positive run number).')
                    return
                }
                let reservation: ChatRunReservation
                if (rerunCommand.type === 'rerun') {
                    if (windowId === undefined) {
                        writeRerunDiagnostic('Rerun requires input arrival identity support.')
                        return
                    }
                    reservation = runs.reserveRerun(rerunCommand.sourceId, windowId)
                    if (reservation.type === 'duplicate') {
                        writeRerunDiagnostic(
                            `Rerun action already accepted as Run #${reservation.run.id}.`
                        )
                        return
                    }
                    if (reservation.type === 'rejected') {
                        const messages: Readonly<Record<typeof reservation.reason, string>> = {
                            invalid_source: 'Usage: /rerun N (positive run number).',
                            source_unavailable: `Run #${rerunCommand.sourceId} is unavailable for rerun.`,
                            source_unsettled: `Run #${rerunCommand.sourceId} is not settled.`,
                            invalid_window: 'Rerun requires a valid input arrival identity.',
                            run_number_exhausted: 'Cannot allocate another run number.',
                        }
                        writeRerunDiagnostic(messages[reservation.reason])
                        return
                    }
                } else {
                    reservation = runs.reserveTask(line)
                }
                if (reservation.type !== 'accepted') throw new ChatTurnError()
                const run = reservation.run
                // Invocation is deferred so control exists before even synchronous run events.
                const controller = createRunController((signal) =>
                    runTurn({
                        conversation,
                        task: run.task,
                        budget: RUN_BUDGET,
                        transport,
                        onEvent: observed.onEvent,
                        signal,
                        patchApprover: createTerminalPatchApprover({
                            input,
                            write: writeAnswer,
                            clearProgress,
                            isInteractive,
                        }),
                    })
                )
                active = controller
                const observed = observations.begin(run.id, run.task, run.rerun)
                try {
                    let result: Awaited<ReturnType<typeof runConversationTurn>>
                    try {
                        result = await controller.settled
                    } catch {
                        observations.fail(observed.id)
                        throw new ChatTurnError()
                    }
                    const session = result.turn.session
                    conversation = result.conversation
                    lastSession = session
                    runs.settle(run.id, session)
                    observations.settle(observed.id, session, () =>
                        renderer.finishAnswer(session.finalAnswer)
                    )
                } finally {
                    controller.dispose()
                    active = undefined
                }
            },
        })

        return {
            exitCode: 0,
            session: lastSession,
        }
    } catch (error) {
        try {
            writeError(error instanceof ChatTurnError ? 'Chat turn failed.' : 'Chat input failed.')
        } catch {
            // Error output cannot prevent returning the already settled CLI outcome.
        }

        return {
            exitCode: 1,
            session: lastSession,
        }
    } finally {
        try {
            try {
                disposeInputInterrupt?.()
            } finally {
                disposeProcessInterrupt?.()
            }
        } finally {
            if (!inputStarted) {
                input.close()
                clearProgress()
            }
        }
    }
}

export const runCli = async (
    argv: readonly string[],
    {
        transport,
        observationClocks,
        observationProjectEvent,
        runTurn,
        writeOutput,
        writeError,
        createAuthorization,
        startCallbackListener,
        exchangeCredential,
        credentialStore,
        createLineInput,
        subscribeProcessInterrupt,
        writeAnswer,
        writeStatus,
        clearStatusLine,
        moveStatusCursorToStart,
        isInteractive,
        formatTechnical,
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
        workspaceRoot = await canonicalizeWorkspaceRoot(parsed.command.cwd ?? '.')
    } catch (error) {
        const cause = error instanceof Error ? error.message : 'Unknown workspace error'

        return runtimeError(`Cannot use workspace: ${cause}`, writeError)
    }

    if (
        createLineInput === undefined ||
        writeAnswer === undefined ||
        writeStatus === undefined ||
        clearStatusLine === undefined ||
        moveStatusCursorToStart === undefined ||
        isInteractive === undefined
    ) {
        return runtimeError('Chat I/O is not configured.', writeError)
    }

    return runChat({
        workspaceRoot,
        model: parsed.command.model,
        transport,
        writeOutput,
        writeError,
        createLineInput,
        writeAnswer,
        writeStatus,
        clearStatusLine,
        moveStatusCursorToStart,
        isInteractive,
        formatTechnical: isInteractive ? (formatTechnical ?? plainTerminalText) : plainTerminalText,
        observationClocks: observationClocks ?? {
            wallTime: Date.now,
            monotonicTime: () => performance.now(),
        },
        observationProjectEvent,
        runTurn: runTurn ?? runConversationTurn,
        subscribeProcessInterrupt:
            subscribeProcessInterrupt ??
            ((listener) => {
                process.on('SIGINT', listener)
                return () => {
                    process.off('SIGINT', listener)
                }
            }),
    })
}
