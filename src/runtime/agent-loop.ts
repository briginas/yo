import type { PermissionDecision } from './permissions.ts'
import type {
    ModelTransport,
    RunBudget,
    RunEvent,
    RunEventObserver,
    RunEventSnapshot,
    RunStatus,
    SessionMessage,
    SessionState,
    StopReason,
} from './run.ts'
import { dispatchToolCall, type PatchDispatchOptions } from './tool-dispatcher.ts'
import type { PatchApprover } from './patch-contracts.ts'
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt.ts'
import type { ToolCall, ToolName, ToolResult } from './tools.ts'

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
    onEvent?: RunEventObserver
    initialMessages?: readonly SessionMessage[]
    patchApprover?: PatchApprover
}

type ToolDispatcher = (
    workspaceRoot: string,
    call: ToolCall,
    perToolTimeoutMs: number,
    onPermissionDecision?: (decision: PermissionDecision) => void,
    patchOptions?: PatchDispatchOptions
) => Promise<ToolResult>

type PatchLifecycleObserver = NonNullable<PatchDispatchOptions['onLifecycleEvent']>

const finishRun = (
    session: SessionState,
    status: Exclude<RunStatus, 'pending' | 'running'>,
    reason: StopReason,
    onEvent: RunEventObserver | undefined
): SessionState => {
    session.status = status
    session.stopReason = reason
    recordAndNotify(session, onEvent, {
        type: 'run_finished',
        status,
        reason,
    })

    return session
}

const freezeSnapshot = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
        return
    }

    Object.freeze(value)

    for (const nestedValue of Object.values(value)) {
        freezeSnapshot(nestedValue)
    }
}

export const createRunEventSnapshot = (event: RunEvent): RunEventSnapshot => {
    const snapshot = structuredClone(event)
    freezeSnapshot(snapshot)

    return snapshot
}

const recordAndNotify = (
    session: SessionState,
    onEvent: RunEventObserver | undefined,
    event: RunEvent
): void => {
    session.events.push(event)

    if (onEvent === undefined) {
        return
    }

    try {
        onEvent(createRunEventSnapshot(event))
    } catch {
        // Observers are non-owning UI hooks and must not affect the agent run.
    }
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

const createPatchLifecycleObserver =
    (
        session: SessionState,
        onEvent: RunEventObserver | undefined,
        step: number,
        callId: string
    ): PatchLifecycleObserver =>
    (event) => {
        switch (event.type) {
            case 'prepared':
                recordAndNotify(session, onEvent, {
                    type: 'patch_prepared',
                    step,
                    callId,
                    metadata: event.metadata,
                })
                return
            case 'approval_requested':
                recordAndNotify(session, onEvent, {
                    type: 'patch_approval_requested',
                    step,
                    callId,
                    metadata: event.metadata,
                })
                return
            case 'approval_resolved':
                recordAndNotify(session, onEvent, {
                    type: 'patch_approval_resolved',
                    step,
                    callId,
                    metadata: event.metadata,
                    decision: event.decision,
                })
                return
            case 'conflicted':
                recordAndNotify(session, onEvent, {
                    type: 'patch_conflicted',
                    step,
                    callId,
                    metadata: event.metadata,
                    conflict: event.conflict,
                })
                return
            case 'applied':
                recordAndNotify(session, onEvent, {
                    type: 'patch_applied',
                    step,
                    callId,
                    metadata: event.metadata,
                })
        }
    }

// Exported only from this internal module so the loop can be tested with a controlled dispatcher.
// The public runtime barrel exposes runAgent with the closed read-only registry.
export const runAgentWithDispatcher = async (
    {
        task,
        workspaceRoot,
        budget,
        model,
        transport,
        onEvent,
        initialMessages,
        patchApprover,
    }: RunAgentOptions,
    dispatch: ToolDispatcher
): Promise<SessionState> => {
    const session: SessionState = {
        task,
        workspaceRoot,
        budget,
        status: 'running',
        stepCount: 0,
        messages: [
            ...(initialMessages === undefined
                ? [
                      {
                          role: 'system' as const,
                          content: DEFAULT_SYSTEM_PROMPT,
                      },
                  ]
                : structuredClone(initialMessages)),
            {
                role: 'user',
                content: task,
            },
        ],
        events: [],
        finalAnswer: null,
        stopReason: null,
    }
    recordAndNotify(session, onEvent, {
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
        recordAndNotify(session, onEvent, {
            type: 'model_requested',
            step: session.stepCount,
            metadata: {
                model,
                visibleTools: [...VISIBLE_TOOLS],
            },
        })

        let response

        try {
            response = await transport(request, {
                onFinalAnswerDelta: (delta) => {
                    recordAndNotify(session, onEvent, {
                        type: 'final_answer_delta',
                        delta,
                    })
                },
            })
        } catch {
            return finishRun(session, 'failed', 'transport_error', onEvent)
        }

        recordAndNotify(session, onEvent, {
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
            recordAndNotify(session, onEvent, {
                type: 'final_answer',
                answer: response.content,
            })

            return finishRun(session, 'completed', 'final_answer', onEvent)
        }

        session.messages.push({
            role: 'assistant',
            content: response.content ?? '',
            toolCalls: [...response.toolCalls],
        })

        for (const call of response.toolCalls) {
            recordAndNotify(session, onEvent, {
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
                        recordAndNotify(session, onEvent, {
                            type: 'tool_authorized',
                            step: session.stepCount,
                            callId: call.id,
                            decision,
                        })
                    },
                    {
                        ...(patchApprover === undefined ? {} : { approver: patchApprover }),
                        onLifecycleEvent: createPatchLifecycleObserver(
                            session,
                            onEvent,
                            session.stepCount,
                            call.id
                        ),
                    }
                )
            } catch (error) {
                result = createUnexpectedDispatcherErrorResult(call, error)
            }

            session.messages.push({
                role: 'tool',
                result,
            })
            recordAndNotify(session, onEvent, {
                type: 'tool_completed',
                step: session.stepCount,
                result,
            })
        }
    }

    return finishRun(session, 'aborted', 'step_budget_exhausted', onEvent)
}

export const runAgent = (options: RunAgentOptions): Promise<SessionState> =>
    runAgentWithDispatcher(options, dispatchToolCall)
