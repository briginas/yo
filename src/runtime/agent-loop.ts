import type { PermissionDecision } from './permissions.ts'
import type { ModelTransport, RunBudget, RunStatus, SessionState, StopReason } from './run.ts'
import { dispatchToolCall } from './tool-dispatcher.ts'
import type { ToolCall, ToolName, ToolResult } from './tools.ts'

const SYSTEM_PROMPT =
    'You are a read-only coding agent. Inspect only the approved workspace through the available read-only tools and base your final answer on tool results.'

const VISIBLE_TOOLS = [
    'list_files',
    'search_code',
    'read_file',
] as const satisfies readonly ToolName[]

export type RunAgentOptions = {
    task: string
    workspaceRoot: string
    budget: RunBudget
    model: string | null
    transport: ModelTransport
}

type ToolDispatcher = (
    workspaceRoot: string,
    call: ToolCall,
    perToolTimeoutMs: number,
    onPermissionDecision?: (decision: PermissionDecision) => void
) => Promise<ToolResult>

const finishRun = (
    session: SessionState,
    status: Exclude<RunStatus, 'pending' | 'running'>,
    reason: StopReason
): SessionState => {
    session.status = status
    session.stopReason = reason
    session.events.push({
        type: 'run_finished',
        status,
        reason,
    })

    return session
}

const createUnexpectedDispatcherErrorResult = (call: ToolCall, error: unknown): ToolResult => {
    const cause = error instanceof Error ? error.message : 'Unknown dispatcher failure'
    const message = `Tool dispatch failed: ${cause}`

    return {
        status: 'execution_error',
        callId: call.id,
        content: message,
        metadata: {
            truncated: false,
            truncation: null,
        },
        error: {
            code: 'execution_error',
            message,
        },
    }
}

// Exported only from this internal module so the loop can be tested with a controlled dispatcher.
// The public runtime barrel exposes runAgent with the closed read-only registry.
export const runAgentWithDispatcher = async (
    { task, workspaceRoot, budget, model, transport }: RunAgentOptions,
    dispatch: ToolDispatcher
): Promise<SessionState> => {
    const session: SessionState = {
        task,
        workspaceRoot,
        budget,
        status: 'running',
        stepCount: 0,
        messages: [
            {
                role: 'system',
                content: SYSTEM_PROMPT,
            },
            {
                role: 'user',
                content: task,
            },
        ],
        events: [],
        finalAnswer: null,
        stopReason: null,
    }
    session.events.push({
        type: 'run_started',
        task,
        workspaceRoot,
        budget: { ...budget },
    })

    while (session.stepCount < budget.maxSteps) {
        session.stepCount += 1
        const request = {
            model,
            messages: [...session.messages],
            visibleTools: [...VISIBLE_TOOLS],
        }
        session.events.push({
            type: 'model_requested',
            step: session.stepCount,
            metadata: {
                model,
                visibleTools: [...VISIBLE_TOOLS],
            },
        })

        let response

        try {
            response = await transport(request)
        } catch {
            return finishRun(session, 'failed', 'transport_error')
        }

        session.events.push({
            type: 'model_responded',
            step: session.stepCount,
            metadata: {
                model: response.model,
                toolCallCount: response.type === 'tool_calls' ? response.toolCalls.length : 0,
                hasFinalAnswer: response.type === 'final_answer',
            },
        })

        if (response.type === 'final_answer') {
            session.messages.push({
                role: 'assistant',
                content: response.content,
                toolCalls: [],
            })
            session.finalAnswer = response.content
            session.events.push({
                type: 'final_answer',
                answer: response.content,
            })

            return finishRun(session, 'completed', 'final_answer')
        }

        session.messages.push({
            role: 'assistant',
            content: response.content ?? '',
            toolCalls: [...response.toolCalls],
        })

        for (const call of response.toolCalls) {
            session.events.push({
                type: 'tool_requested',
                step: session.stepCount,
                call,
            })

            let result: ToolResult

            try {
                result = await dispatch(
                    workspaceRoot,
                    call,
                    budget.perToolTimeoutMs,
                    (decision) => {
                        session.events.push({
                            type: 'tool_authorized',
                            step: session.stepCount,
                            callId: call.id,
                            decision,
                        })
                    }
                )
            } catch (error) {
                result = createUnexpectedDispatcherErrorResult(call, error)
            }

            session.messages.push({
                role: 'tool',
                result,
            })
            session.events.push({
                type: 'tool_completed',
                step: session.stepCount,
                result,
            })
        }
    }

    return finishRun(session, 'aborted', 'step_budget_exhausted')
}

export const runAgent = (options: RunAgentOptions): Promise<SessionState> =>
    runAgentWithDispatcher(options, dispatchToolCall)
