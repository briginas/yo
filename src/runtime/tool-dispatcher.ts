import type { ZodType } from 'zod'

import { executeSettledOperation } from './settled-operation.ts'
import { listFiles, readFile, searchCode } from './filesystem.ts'
import { applyPatchProposalWithTimeout, type PatchApplicationOutcome } from './patch-applier.ts'
import { requestPatchApproval } from './patch-approval.ts'
import {
    type PatchApprovalDecision,
    type PatchApprover,
    type PatchConflict,
    type PatchLifecycleMetadata,
    type PatchProposal,
    proposePatchArgumentsSchema,
} from './patch-contracts.ts'
import { PatchPreparationError, preparePatchProposal } from './patch-preparer.ts'
import { PatchTransformError } from './patch-transform.ts'
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
    onPermissionDecision?: (decision: PermissionDecision) => void,
    executionOptions?: ToolExecutionOptions
) => Promise<ToolResult>

type PatchLifecycleEvent =
    | Readonly<{
          type: 'prepared'
          metadata: PatchLifecycleMetadata
      }>
    | Readonly<{
          type: 'approval_requested'
          metadata: PatchLifecycleMetadata
      }>
    | Readonly<{
          type: 'approval_resolved'
          metadata: PatchLifecycleMetadata
          decision: PatchApprovalDecision
      }>
    | Readonly<{
          type: 'conflicted'
          metadata: PatchLifecycleMetadata
          conflict: PatchConflict['code']
      }>
    | Readonly<{
          type: 'applied'
          metadata: PatchLifecycleMetadata
      }>

type PatchPreparation = (
    workspaceRoot: string,
    path: string,
    edits: readonly { oldText: string; newText: string }[],
    options?: ToolExecutionOptions
) => Promise<PatchProposal>

type PatchApplication = (
    workspaceRoot: string,
    proposal: PatchProposal,
    timeoutMs: number
) => Promise<PatchApplicationOutcome | Readonly<{ status: 'timeout' }>>

export type PatchDispatchOptions = Readonly<{
    approver?: PatchApprover
    onLifecycleEvent?: (event: PatchLifecycleEvent) => void
    operations?: Readonly<{
        prepareProposal?: PatchPreparation
        applyProposal?: PatchApplication
    }>
}>

export type ToolExecutionOptions = Readonly<{
    signal?: AbortSignal
}>

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

const patchLifecycleMetadata = (proposal: PatchProposal): PatchLifecycleMetadata =>
    Object.freeze({
        proposalId: proposal.id,
        relativePath: proposal.relativePath,
        baseHash: proposal.baseHash,
        nextHash: proposal.nextHash,
        addedLineCount: proposal.addedLineCount,
        removedLineCount: proposal.removedLineCount,
    })

const notifyPatchLifecycle = (
    options: PatchDispatchOptions | undefined,
    event: PatchLifecycleEvent
): void => {
    try {
        options?.onLifecycleEvent?.(event)
    } catch {
        // Lifecycle observers are non-owning telemetry hooks and cannot alter a patch decision.
    }
}

const isPatchPolicyDenial = (
    code: PatchPreparationError['code']
): code is
    'outside_workspace' | 'sensitive_path' | 'missing_path' | 'symlink_path' | 'non_regular_file' =>
    code === 'outside_workspace' ||
    code === 'sensitive_path' ||
    code === 'missing_path' ||
    code === 'symlink_path' ||
    code === 'non_regular_file'

const dispatchPatchCall = async (
    workspaceRoot: string,
    call: ToolCall,
    perToolTimeoutMs: number,
    onPermissionDecision: ((decision: PermissionDecision) => void) | undefined,
    options: PatchDispatchOptions | undefined,
    executionOptions?: ToolExecutionOptions
): Promise<ToolResult> => {
    const parsedArguments = proposePatchArgumentsSchema.safeParse(call.arguments)
    if (!parsedArguments.success) {
        const message = `Invalid arguments for ${call.name}: ${formatValidationIssues(parsedArguments.error.issues)}`

        return createErrorResult(call.id, 'invalid_arguments', 'invalid_arguments', message)
    }

    const prepareProposal: PatchPreparation =
        options?.operations?.prepareProposal ??
        ((root, path, edits, execution) =>
            preparePatchProposal(root, path, edits, undefined, execution?.signal))
    let proposal: PatchProposal
    try {
        const outcome = await executeSettledOperation(
            (signal) =>
                prepareProposal(
                    workspaceRoot,
                    parsedArguments.data.path,
                    parsedArguments.data.edits,
                    { signal }
                ),
            { timeoutMs: perToolTimeoutMs, signal: executionOptions?.signal }
        )

        if (outcome.status === 'timeout') {
            return createErrorResult(
                call.id,
                'timeout',
                'timeout',
                `Tool execution timed out after ${perToolTimeoutMs} ms`
            )
        }
        if (outcome.status === 'aborted') {
            return createErrorResult(call.id, 'aborted', 'aborted', 'Tool execution was aborted')
        }
        proposal = outcome.result
    } catch (error) {
        if (error instanceof PatchPreparationError) {
            if (isPatchPolicyDenial(error.code)) {
                if (error.code === 'outside_workspace' || error.code === 'sensitive_path') {
                    onPermissionDecision?.({ decision: 'deny', reason: error.code })
                }

                const message = `Tool access denied: ${error.code}`
                return createErrorResult(call.id, 'denied', error.code, message)
            }

            if (error.code === 'source_too_large') {
                return createErrorResult(call.id, 'invalid_arguments', error.code, error.message)
            }
        }

        if (error instanceof PatchTransformError) {
            return createErrorResult(call.id, 'invalid_arguments', error.code, error.message)
        }

        return createErrorResult(
            call.id,
            'execution_error',
            'execution_error',
            'Tool execution failed: Unable to prepare patch proposal'
        )
    }

    onPermissionDecision?.({ decision: 'allow' })
    const metadata = patchLifecycleMetadata(proposal)
    notifyPatchLifecycle(options, { type: 'prepared', metadata })
    notifyPatchLifecycle(options, { type: 'approval_requested', metadata })

    const approval = await requestPatchApproval(proposal, options?.approver)
    notifyPatchLifecycle(options, { type: 'approval_resolved', metadata, decision: approval })

    if (approval === 'aborted') {
        return createErrorResult(
            call.id,
            'aborted',
            'approval_aborted',
            'Patch approval was aborted'
        )
    }
    if (approval === 'denied') {
        return createErrorResult(call.id, 'denied', 'approval_denied', 'Patch approval denied')
    }

    const applyProposal = options?.operations?.applyProposal ?? applyPatchProposalWithTimeout
    try {
        const outcome = await applyProposal(workspaceRoot, proposal, perToolTimeoutMs)
        if (outcome.status === 'timeout') {
            return createErrorResult(
                call.id,
                'timeout',
                'timeout',
                `Tool execution timed out after ${perToolTimeoutMs} ms`
            )
        }
        if (outcome.status === 'aborted') {
            return createErrorResult(call.id, 'aborted', 'aborted', 'Patch application was aborted')
        }
        if (outcome.status === 'conflict') {
            notifyPatchLifecycle(options, {
                type: 'conflicted',
                metadata,
                conflict: outcome.conflict.code,
            })
            return createErrorResult(
                call.id,
                'execution_error',
                outcome.conflict.code,
                `Patch conflict: ${outcome.conflict.message}`
            )
        }

        notifyPatchLifecycle(options, { type: 'applied', metadata })
        return {
            status: 'success',
            callId: call.id,
            content: `Patch applied: ${proposal.relativePath}`,
            metadata: completeMetadata(),
        }
    } catch {
        return createErrorResult(
            call.id,
            'execution_error',
            'execution_error',
            'Tool execution failed: Unable to apply approved patch'
        )
    }
}

// Exported only from this internal module so timeout behavior can be verified with a controlled
// executor. The public runtime barrel exposes only dispatchToolCall.
export const registerTool = <TArguments>(
    schema: ZodType<TArguments>,
    authorize: (
        workspaceRoot: string,
        arguments_: TArguments,
        options?: ToolExecutionOptions
    ) => Promise<WorkspacePathPermissionDecision>,
    execute: (
        workspaceRoot: string,
        arguments_: TArguments,
        options?: ToolExecutionOptions
    ) => Promise<ToolExecutionResult>
): RegisteredTool => {
    return async (
        workspaceRoot,
        call,
        perToolTimeoutMs,
        onPermissionDecision,
        executionOptions
    ) => {
        const parsedArguments = schema.safeParse(call.arguments)

        if (!parsedArguments.success) {
            const message = `Invalid arguments for ${call.name}: ${formatValidationIssues(parsedArguments.error.issues)}`

            return createErrorResult(call.id, 'invalid_arguments', 'invalid_arguments', message)
        }

        try {
            const authorization = await executeSettledOperation(
                (signal) => authorize(workspaceRoot, parsedArguments.data, { signal }),
                { signal: executionOptions?.signal }
            )
            if (authorization.status !== 'completed') {
                return createErrorResult(
                    call.id,
                    'aborted',
                    'aborted',
                    'Tool execution was aborted'
                )
            }
            const permissionDecision = authorization.result
            onPermissionDecision?.(
                permissionDecision.decision === 'allow' ? { decision: 'allow' } : permissionDecision
            )

            if (permissionDecision.decision === 'deny') {
                const message = `Tool access denied: ${permissionDecision.reason}`

                return createErrorResult(call.id, 'denied', permissionDecision.reason, message)
            }

            const outcome = await executeSettledOperation(
                (signal) => execute(workspaceRoot, parsedArguments.data, { signal }),
                { timeoutMs: perToolTimeoutMs, signal: executionOptions?.signal }
            )

            if (outcome.status === 'timeout') {
                const message = `Tool execution timed out after ${perToolTimeoutMs} ms`

                return createErrorResult(call.id, 'timeout', 'timeout', message)
            }

            if (outcome.status === 'aborted') {
                return createErrorResult(
                    call.id,
                    'aborted',
                    'aborted',
                    'Tool execution was aborted'
                )
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

// Keeping this generic registry closed makes the absence of general write, process, and network
// tools a runtime invariant. The single approval-gated patch path is dispatched separately above.
const registeredTools = {
    list_files: registerTool(
        listFilesArgumentsSchema,
        (workspaceRoot, arguments_, options) =>
            resolveWorkspacePath(workspaceRoot, arguments_.path, options?.signal),
        async (workspaceRoot, arguments_, options) => {
            const result = await listFiles(workspaceRoot, arguments_, options)

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
        (workspaceRoot, arguments_, options) =>
            resolveWorkspacePath(workspaceRoot, arguments_.path ?? '.', options?.signal),
        async (workspaceRoot, arguments_, options) => {
            const result = await searchCode(workspaceRoot, arguments_, options)

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
        (workspaceRoot, arguments_, options) =>
            resolveWorkspacePath(workspaceRoot, arguments_.path, options?.signal),
        async (workspaceRoot, arguments_, options) => {
            const result = await readFile(workspaceRoot, arguments_, options)

            return result.status === 'success'
                ? {
                      status: 'success',
                      content: result.content,
                      metadata: result.metadata,
                  }
                : result
        }
    ),
} satisfies Record<Exclude<ToolName, 'propose_patch'>, RegisteredTool>

const isRegisteredToolName = (name: string): name is Exclude<ToolName, 'propose_patch'> =>
    Object.hasOwn(registeredTools, name)

export const dispatchToolCall = async (
    workspaceRoot: string,
    call: ToolCall,
    perToolTimeoutMs: number,
    onPermissionDecision?: (decision: PermissionDecision) => void,
    patchOptions?: PatchDispatchOptions,
    executionOptions?: ToolExecutionOptions
): Promise<ToolResult> => {
    if (call.name === 'propose_patch') {
        return dispatchPatchCall(
            workspaceRoot,
            call,
            perToolTimeoutMs,
            onPermissionDecision,
            patchOptions,
            executionOptions
        )
    }

    if (!isRegisteredToolName(call.name)) {
        const message = `Unknown tool: ${call.name}`
        onPermissionDecision?.({ decision: 'deny', reason: 'unknown_tool' })

        return createErrorResult(call.id, 'unknown_tool', 'unknown_tool', message)
    }

    return registeredTools[call.name](
        workspaceRoot,
        call,
        perToolTimeoutMs,
        onPermissionDecision,
        executionOptions
    )
}
