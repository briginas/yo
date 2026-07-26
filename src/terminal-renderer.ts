import type { RunEventObserver, RunEventSnapshot, RunStatus, StopReason } from './runtime/run.ts'
import {
    listFilesArgumentsSchema,
    readFileArgumentsSchema,
    searchCodeArgumentsSchema,
    type ToolName,
    type ToolResultTruncation,
} from './runtime/tools.ts'

export type TerminalTextWriter = (message: string) => void

type SafeToolName = ToolName | 'unknown_tool'

export type TerminalStatus =
    | {
          type: 'model_waiting'
          step: number
          active: boolean
      }
    | {
          type: 'tool_running' | 'tool_completed' | 'tool_denied' | 'tool_timeout' | 'tool_failed'
          step: number
          callId: string
          toolName: SafeToolName
          argumentSummary: string | null
          truncation: ToolResultTruncation | null
      }
    | {
          type: 'turn_finished'
          status: Exclude<RunStatus, 'pending' | 'running'>
          reason: StopReason
      }

export type TerminalStatusWriter = (status: TerminalStatus) => void

export type CreateTerminalStatusOutputOptions = {
    write: TerminalTextWriter
    clearLine: () => void
    moveCursorToStart: () => void
    isInteractive: boolean
}

export type TerminalStatusOutput = {
    readonly writeStatus: TerminalStatusWriter
    readonly clearProgress: () => void
}

export type CreateTerminalRendererOptions = {
    writeAnswer: TerminalTextWriter
    writeStatus: TerminalStatusWriter
    writeError: TerminalTextWriter
    isInteractive: boolean
}

export type TerminalRenderer = {
    readonly isInteractive: boolean
    readonly onEvent: RunEventObserver
    readonly finishAnswer: (answer: string | null) => void
    readonly writeAnswer: TerminalTextWriter
    readonly writeError: TerminalTextWriter
}

type RequestedTool = {
    step: number
    toolName: SafeToolName
    argumentSummary: string | null
}

const SAFE_STRING_MAX_CHARACTERS = 80
const SENSITIVE_VALUE_PATTERN =
    /(?:authorization|bearer|access_token|refresh_token|client_secret|sk-)/i

const normalizeSingleLine = (value: string): string =>
    value
        .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

const formatSafeString = (value: string): string => {
    if (SENSITIVE_VALUE_PATTERN.test(value)) {
        return '<redacted>'
    }

    const escaped = normalizeSingleLine(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    const characters = [...escaped]
    const preview =
        characters.length > SAFE_STRING_MAX_CHARACTERS
            ? `${characters.slice(0, SAFE_STRING_MAX_CHARACTERS - 3).join('')}...`
            : escaped

    return `"${preview}"`
}

const formatOptionalField = (name: string, value: string | number | undefined): string[] =>
    value === undefined
        ? []
        : [`${name}=${typeof value === 'string' ? formatSafeString(value) : value}`]

const summarizeToolArguments = (
    name: string,
    arguments_: unknown
): Pick<RequestedTool, 'toolName' | 'argumentSummary'> => {
    switch (name) {
        case 'list_files': {
            const parsed = listFilesArgumentsSchema.safeParse(arguments_)

            if (!parsed.success) {
                return { toolName: name, argumentSummary: null }
            }

            return {
                toolName: name,
                argumentSummary: [
                    `path=${formatSafeString(parsed.data.path)}`,
                    ...formatOptionalField('glob', parsed.data.glob),
                    ...formatOptionalField('limit', parsed.data.limit),
                ].join(' '),
            }
        }
        case 'search_code': {
            const parsed = searchCodeArgumentsSchema.safeParse(arguments_)

            if (!parsed.success) {
                return { toolName: name, argumentSummary: null }
            }

            return {
                toolName: name,
                argumentSummary: [
                    `query=${formatSafeString(parsed.data.query)}`,
                    ...formatOptionalField('path', parsed.data.path),
                    ...formatOptionalField('glob', parsed.data.glob),
                    ...formatOptionalField('limit', parsed.data.limit),
                ].join(' '),
            }
        }
        case 'read_file': {
            const parsed = readFileArgumentsSchema.safeParse(arguments_)

            if (!parsed.success) {
                return { toolName: name, argumentSummary: null }
            }

            const { path, startLine, endLine } = parsed.data
            const lineRange =
                startLine === undefined && endLine === undefined
                    ? []
                    : [`lines=${startLine ?? '*'}-${endLine ?? '*'}`]

            return {
                toolName: name,
                argumentSummary: [`path=${formatSafeString(path)}`, ...lineRange].join(' '),
            }
        }
        default:
            return {
                toolName: 'unknown_tool',
                argumentSummary: null,
            }
    }
}

const mapToolCompletionType = (
    event: Extract<RunEventSnapshot, { type: 'tool_completed' }>
): Extract<TerminalStatus, { callId: string }>['type'] => {
    switch (event.result.status) {
        case 'success':
            return 'tool_completed'
        case 'denied':
            return 'tool_denied'
        case 'timeout':
            return 'tool_timeout'
        case 'invalid_arguments':
        case 'unknown_tool':
        case 'execution_error':
        case 'aborted':
            return 'tool_failed'
    }
}

export const formatTerminalStatusLine = (status: TerminalStatus): string => {
    switch (status.type) {
        case 'model_waiting':
            return normalizeSingleLine(
                `status: ${status.active ? 'model_waiting' : 'model_ready'} step=${status.step}`
            )
        case 'tool_running':
        case 'tool_completed':
        case 'tool_denied':
        case 'tool_timeout':
        case 'tool_failed': {
            const arguments_ =
                status.argumentSummary === null ? 'arguments=unavailable' : status.argumentSummary
            const truncation =
                status.truncation === null
                    ? ''
                    : ` truncated=${status.truncation.reason} limit=${status.truncation.limit} observed=${status.truncation.observed}`

            return normalizeSingleLine(
                `status: ${status.type} step=${status.step} tool=${status.toolName} ${arguments_}${truncation}`
            )
        }
        case 'turn_finished':
            return normalizeSingleLine(
                `status: turn_finished status=${status.status} reason=${status.reason}`
            )
    }
}

export const createTerminalStatusOutput = ({
    write,
    clearLine,
    moveCursorToStart,
    isInteractive,
}: CreateTerminalStatusOutputOptions): TerminalStatusOutput => {
    let hasActiveProgress = false

    const clearProgress = (): void => {
        if (!isInteractive || !hasActiveProgress) {
            return
        }

        clearLine()
        moveCursorToStart()
        hasActiveProgress = false
    }

    const writeInteractiveProgress = (status: TerminalStatus): void => {
        clearLine()
        moveCursorToStart()
        write(formatTerminalStatusLine(status))
        hasActiveProgress = true
    }

    const writeStatus: TerminalStatusWriter = (status) => {
        if (!isInteractive) {
            write(`${formatTerminalStatusLine(status)}\n`)
            return
        }

        if (status.type === 'model_waiting') {
            if (status.active) {
                writeInteractiveProgress(status)
            } else {
                clearProgress()
            }

            return
        }

        if (status.type === 'tool_running') {
            writeInteractiveProgress(status)
            return
        }

        clearProgress()
        write(`${formatTerminalStatusLine(status)}\n`)
    }

    return {
        writeStatus,
        clearProgress,
    }
}

export const createTerminalRenderer = ({
    writeAnswer,
    writeStatus,
    writeError,
    isInteractive,
}: CreateTerminalRendererOptions): TerminalRenderer => {
    const requestedTools = new Map<string, RequestedTool>()
    let activeModelStep: number | null = null
    let answerReleaseAttempted = false
    let answerFinished = false

    const finishReleasedAnswer = (): void => {
        if (answerFinished || !answerReleaseAttempted) {
            return
        }

        answerFinished = true
        writeAnswer('\n\n')
    }

    const settleModelWaiting = (step: number | null = activeModelStep): void => {
        if (activeModelStep === null || step !== activeModelStep) {
            return
        }

        activeModelStep = null
        writeStatus({
            type: 'model_waiting',
            step,
            active: false,
        })
    }

    const finishAnswer = (answer: string | null): void => {
        if (answerFinished) {
            return
        }

        if (answerReleaseAttempted) {
            finishReleasedAnswer()
            return
        }

        answerFinished = true

        if (answer === null) {
            return
        }

        writeAnswer(`${answer}\n\n`)
    }

    const onEvent: RunEventObserver = (event) => {
        switch (event.type) {
            case 'run_started':
                answerReleaseAttempted = false
                answerFinished = false
                return
            case 'model_requested':
                settleModelWaiting()
                activeModelStep = event.step
                writeStatus({
                    type: 'model_waiting',
                    step: event.step,
                    active: true,
                })
                return
            case 'model_responded':
                settleModelWaiting(event.step)
                return
            case 'final_answer_delta':
                settleModelWaiting()

                if (event.delta.length === 0) {
                    return
                }

                answerReleaseAttempted = true
                writeAnswer(event.delta)
                return
            case 'tool_requested': {
                const summary = summarizeToolArguments(event.call.name, event.call.arguments)

                requestedTools.set(event.call.id, {
                    step: event.step,
                    ...summary,
                })
                return
            }
            case 'tool_authorized': {
                if (event.decision.decision === 'deny') {
                    return
                }

                const requestedTool = requestedTools.get(event.callId)

                if (requestedTool === undefined) {
                    return
                }

                settleModelWaiting(requestedTool.step)
                writeStatus({
                    type: 'tool_running',
                    step: requestedTool.step,
                    callId: event.callId,
                    toolName: requestedTool.toolName,
                    argumentSummary: requestedTool.argumentSummary,
                    truncation: null,
                })
                return
            }
            case 'tool_completed': {
                const requestedTool = requestedTools.get(event.result.callId)

                if (requestedTool === undefined) {
                    return
                }

                requestedTools.delete(event.result.callId)
                writeStatus({
                    type: mapToolCompletionType(event),
                    step: requestedTool.step,
                    callId: event.result.callId,
                    toolName: requestedTool.toolName,
                    argumentSummary: requestedTool.argumentSummary,
                    truncation:
                        event.result.metadata.truncated && event.result.metadata.truncation !== null
                            ? { ...event.result.metadata.truncation }
                            : null,
                })
                return
            }
            case 'run_finished':
                activeModelStep = null
                requestedTools.clear()
                finishReleasedAnswer()
                writeStatus({
                    type: 'turn_finished',
                    status: event.status,
                    reason: event.reason,
                })
                return
            case 'final_answer':
                return
        }
    }

    return {
        isInteractive,
        onEvent,
        finishAnswer,
        writeAnswer,
        writeError,
    }
}
