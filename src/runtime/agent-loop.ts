import type { ModelTransport, RunBudget, SessionState } from './run.ts'
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
    perToolTimeoutMs: number
) => Promise<ToolResult>

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

    while (session.stepCount < budget.maxSteps) {
        session.stepCount += 1

        const response = await transport({
            model,
            messages: [...session.messages],
            visibleTools: [...VISIBLE_TOOLS],
        })

        if (response.type === 'final_answer') {
            session.messages.push({
                role: 'assistant',
                content: response.content,
                toolCalls: [],
            })
            session.status = 'completed'
            session.finalAnswer = response.content
            session.stopReason = 'final_answer'

            return session
        }

        session.messages.push({
            role: 'assistant',
            content: response.content ?? '',
            toolCalls: [...response.toolCalls],
        })

        for (const call of response.toolCalls) {
            const result = await dispatch(workspaceRoot, call, budget.perToolTimeoutMs)

            session.messages.push({
                role: 'tool',
                result,
            })
        }
    }

    session.status = 'aborted'
    session.stopReason = 'step_budget_exhausted'

    return session
}

export const runAgent = (options: RunAgentOptions): Promise<SessionState> =>
    runAgentWithDispatcher(options, dispatchToolCall)
