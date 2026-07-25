import type { PermissionDecision } from './permissions'
import type { ToolCall, ToolName, ToolResult } from './tools'

export type RunStatus = 'pending' | 'running' | 'completed' | 'aborted' | 'failed'

export type StopReason = 'final_answer' | 'step_budget_exhausted' | 'aborted' | 'transport_error'

export type RunBudget = {
    maxSteps: number
    perToolTimeoutMs: number
}

export type ModelRequest = {
    model: string | null
    messages: readonly SessionMessage[]
    visibleTools: readonly ToolName[]
}

export type ModelResponse =
    | {
          type: 'final_answer'
          model: string | null
          content: string
      }
    | {
          type: 'tool_calls'
          model: string | null
          content?: string
          toolCalls: readonly [ToolCall, ...ToolCall[]]
      }

export type ModelTransport = (request: ModelRequest) => Promise<ModelResponse>

export type ModelRequestMetadata = {
    model: string | null
    visibleTools: ToolName[]
}

export type ModelResponseMetadata = {
    model: string | null
    toolCallCount: number
    hasFinalAnswer: boolean
}

export type RunEvent =
    | {
          type: 'run_started'
          task: string
          workspaceRoot: string
          budget: RunBudget
      }
    | {
          type: 'model_requested'
          step: number
          metadata: ModelRequestMetadata
      }
    | {
          type: 'model_responded'
          step: number
          metadata: ModelResponseMetadata
      }
    | {
          type: 'tool_requested'
          step: number
          call: ToolCall
      }
    | {
          type: 'tool_authorized'
          step: number
          callId: string
          decision: PermissionDecision
      }
    | {
          type: 'tool_completed'
          step: number
          result: ToolResult
      }
    | {
          type: 'final_answer'
          answer: string
      }
    | {
          type: 'final_answer_delta'
          delta: string
      }
    | {
          type: 'run_finished'
          status: Exclude<RunStatus, 'pending' | 'running'>
          reason: StopReason
      }

type ReadonlyDeep<Value> = Value extends (...arguments_: never[]) => unknown
    ? Value
    : Value extends readonly (infer Item)[]
      ? readonly ReadonlyDeep<Item>[]
      : Value extends object
        ? { readonly [Key in keyof Value]: ReadonlyDeep<Value[Key]> }
        : Value

export type RunEventSnapshot = ReadonlyDeep<RunEvent>

export type RunEventObserver = (event: RunEventSnapshot) => void

export type SystemMessage = {
    role: 'system'
    content: string
}

export type UserMessage = {
    role: 'user'
    content: string
}

export type AssistantMessage = {
    role: 'assistant'
    content: string
    toolCalls: ToolCall[]
}

export type ToolMessage = {
    role: 'tool'
    result: ToolResult
}

export type SessionMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage

export type ConversationMessage = UserMessage | AssistantMessage | ToolMessage

export type SessionState = {
    task: string
    workspaceRoot: string
    budget: RunBudget
    status: RunStatus
    stepCount: number
    messages: SessionMessage[]
    events: RunEvent[]
    finalAnswer: string | null
    stopReason: StopReason | null
}
