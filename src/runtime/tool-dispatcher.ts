import type { ZodType } from 'zod'

import { listFiles, readFile, searchCode } from './filesystem.ts'
import type { PermissionDecision, WorkspacePathPermissionDecision } from './permissions.ts'
import {
    listFilesArgumentsSchema,
    readFileArgumentsSchema,
    searchCodeArgumentsSchema,
} from './tools.ts'
import { resolveWorkspacePath } from './workspace.ts'
import type {
    ToolCall,
    ToolName,
    ToolResult,
    ToolResultMetadata,
    ToolResultStatus,
} from './tools.ts'

type ToolExecutionResult =
    | {
          status: 'success'
          content: string
          metadata: ToolResultMetadata
      }
    | {
          status: 'denied'
          reason: 'outside_workspace' | 'sensitive_path'
      }

type RegisteredTool = (
    workspaceRoot: string,
    call: ToolCall,
    perToolTimeoutMs: number,
    onPermissionDecision?: (decision: PermissionDecision) => void
) => Promise<ToolResult>

type ToolExecutionOutcome =
    | {
          status: 'completed'
          result: ToolExecutionResult
      }
    | {
          status: 'timeout'
      }

const completeMetadata = (): ToolResultMetadata => ({
    truncated: false,
    truncation: null,
})

const createErrorResult = (
    callId: string,
    status: Exclude<ToolResultStatus, 'success'>,
    code: string,
    message: string
): ToolResult => ({
    status,
    callId,
    content: message,
    metadata: completeMetadata(),
    error: {
        code,
        message,
    },
})

const formatValidationIssues = (issues: readonly { path: PropertyKey[]; message: string }[]) =>
    issues
        .map((issue) => {
            const path = issue.path.length === 0 ? 'arguments' : issue.path.map(String).join('.')

            return `${path}: ${issue.message}`
        })
        .join('; ')

const executeWithTimeout = async (
    execute: () => Promise<ToolExecutionResult>,
    timeoutMs: number
): Promise<ToolExecutionOutcome> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutOutcome = new Promise<Extract<ToolExecutionOutcome, { status: 'timeout' }>>(
        (resolve) => {
            timeout = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)
        }
    )
    const executionOutcome = Promise.resolve()
        .then(execute)
        .then((result): Extract<ToolExecutionOutcome, { status: 'completed' }> => ({
            status: 'completed',
            result,
        }))

    try {
        return await Promise.race([executionOutcome, timeoutOutcome])
    } finally {
        clearTimeout(timeout)
    }
}

// Exported only from this internal module so timeout behavior can be verified with a controlled
// executor. The public runtime barrel exposes only dispatchToolCall.
export const registerTool = <TArguments>(
    schema: ZodType<TArguments>,
    authorize: (
        workspaceRoot: string,
        arguments_: TArguments
    ) => Promise<WorkspacePathPermissionDecision>,
    execute: (workspaceRoot: string, arguments_: TArguments) => Promise<ToolExecutionResult>
): RegisteredTool => {
    return async (workspaceRoot, call, perToolTimeoutMs, onPermissionDecision) => {
        const parsedArguments = schema.safeParse(call.arguments)

        if (!parsedArguments.success) {
            const message = `Invalid arguments for ${call.name}: ${formatValidationIssues(parsedArguments.error.issues)}`

            return createErrorResult(call.id, 'invalid_arguments', 'invalid_arguments', message)
        }

        try {
            const permissionDecision = await authorize(workspaceRoot, parsedArguments.data)
            onPermissionDecision?.(
                permissionDecision.decision === 'allow' ? { decision: 'allow' } : permissionDecision
            )

            if (permissionDecision.decision === 'deny') {
                const message = `Tool access denied: ${permissionDecision.reason}`

                return createErrorResult(call.id, 'denied', permissionDecision.reason, message)
            }

            const outcome = await executeWithTimeout(
                () => execute(workspaceRoot, parsedArguments.data),
                perToolTimeoutMs
            )

            if (outcome.status === 'timeout') {
                const message = `Tool execution timed out after ${perToolTimeoutMs} ms`

                return createErrorResult(call.id, 'timeout', 'timeout', message)
            }

            const result = outcome.result

            // Filesystem tools repeat path authorization internally so the safety boundary does
            // not depend solely on dispatcher preflight.
            if (result.status === 'denied') {
                const message = `Tool access denied: ${result.reason}`

                return createErrorResult(call.id, 'denied', result.reason, message)
            }

            return {
                status: 'success',
                callId: call.id,
                content: result.content,
                metadata: result.metadata,
            }
        } catch (error) {
            const cause = error instanceof Error ? error.message : 'Unknown execution failure'
            const message = `Tool execution failed: ${cause}`

            return createErrorResult(call.id, 'execution_error', 'execution_error', message)
        }
    }
}

// Keeping the registry closed makes the absence of write, process, and network tools a runtime
// invariant rather than a promise made only in the model instructions.
const registeredTools = {
    list_files: registerTool(
        listFilesArgumentsSchema,
        (workspaceRoot, arguments_) => resolveWorkspacePath(workspaceRoot, arguments_.path),
        async (workspaceRoot, arguments_) => {
            const result = await listFiles(workspaceRoot, arguments_)

            return result.status === 'success'
                ? {
                      status: 'success',
                      content: result.entries.join('\n'),
                      metadata: result.metadata,
                  }
                : result
        }
    ),
    search_code: registerTool(
        searchCodeArgumentsSchema,
        (workspaceRoot, arguments_) => resolveWorkspacePath(workspaceRoot, arguments_.path ?? '.'),
        async (workspaceRoot, arguments_) => {
            const result = await searchCode(workspaceRoot, arguments_)

            return result.status === 'success'
                ? {
                      status: 'success',
                      content: result.matches.join('\n'),
                      metadata: result.metadata,
                  }
                : result
        }
    ),
    read_file: registerTool(
        readFileArgumentsSchema,
        (workspaceRoot, arguments_) => resolveWorkspacePath(workspaceRoot, arguments_.path),
        async (workspaceRoot, arguments_) => {
            const result = await readFile(workspaceRoot, arguments_)

            return result.status === 'success'
                ? {
                      status: 'success',
                      content: result.content,
                      metadata: result.metadata,
                  }
                : result
        }
    ),
} satisfies Record<ToolName, RegisteredTool>

const isRegisteredToolName = (name: string): name is ToolName =>
    Object.hasOwn(registeredTools, name)

export const dispatchToolCall = async (
    workspaceRoot: string,
    call: ToolCall,
    perToolTimeoutMs: number,
    onPermissionDecision?: (decision: PermissionDecision) => void
): Promise<ToolResult> => {
    if (!isRegisteredToolName(call.name)) {
        const message = `Unknown tool: ${call.name}`
        onPermissionDecision?.({ decision: 'deny', reason: 'unknown_tool' })

        return createErrorResult(call.id, 'unknown_tool', 'unknown_tool', message)
    }

    return registeredTools[call.name](workspaceRoot, call, perToolTimeoutMs, onPermissionDecision)
}
