import type { RunEventObserver, RunEventSnapshot, RunStatus, StopReason } from './runtime/run.ts'

export type TerminalTextWriter = (message: string) => void

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
          toolName: string
      }
    | {
          type: 'turn_finished'
          status: Exclude<RunStatus, 'pending' | 'running'>
          reason: StopReason
      }

export type TerminalStatusWriter = (status: TerminalStatus) => void

export type CreateTerminalRendererOptions = {
    writeAnswer: TerminalTextWriter
    writeStatus: TerminalStatusWriter
    writeError: TerminalTextWriter
    isInteractive: boolean
}

export type TerminalRenderer = {
    readonly isInteractive: boolean
    readonly onEvent: RunEventObserver
    readonly writeAnswer: TerminalTextWriter
    readonly writeError: TerminalTextWriter
}

type RequestedTool = {
    step: number
    name: string
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

export const createTerminalRenderer = ({
    writeAnswer,
    writeStatus,
    writeError,
    isInteractive,
}: CreateTerminalRendererOptions): TerminalRenderer => {
    const requestedTools = new Map<string, RequestedTool>()

    const onEvent: RunEventObserver = (event) => {
        switch (event.type) {
            case 'model_requested':
                writeStatus({
                    type: 'model_waiting',
                    step: event.step,
                    active: true,
                })
                return
            case 'model_responded':
                writeStatus({
                    type: 'model_waiting',
                    step: event.step,
                    active: false,
                })
                return
            case 'tool_requested':
                requestedTools.set(event.call.id, {
                    step: event.step,
                    name: event.call.name,
                })
                return
            case 'tool_authorized': {
                if (event.decision.decision === 'deny') {
                    return
                }

                const requestedTool = requestedTools.get(event.callId)

                if (requestedTool === undefined) {
                    return
                }

                writeStatus({
                    type: 'tool_running',
                    step: requestedTool.step,
                    callId: event.callId,
                    toolName: requestedTool.name,
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
                    toolName: requestedTool.name,
                })
                return
            }
            case 'run_finished':
                requestedTools.clear()
                writeStatus({
                    type: 'turn_finished',
                    status: event.status,
                    reason: event.reason,
                })
                return
            case 'run_started':
            case 'final_answer':
            case 'final_answer_delta':
                return
        }
    }

    return {
        isInteractive,
        onEvent,
        writeAnswer,
        writeError,
    }
}
