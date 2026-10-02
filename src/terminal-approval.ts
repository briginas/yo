import { LineReadAbortedError, type LineInput } from './line-input.ts'
import type {
    PatchApprovalDecision,
    PatchApprovalView,
    PatchApprover,
} from './runtime/patch-contracts.ts'

export const PATCH_APPROVAL_PROMPT = 'Apply this patch? [y/N] '

export type CreateTerminalPatchApproverOptions = {
    input?: LineInput
    write: (message: string) => void
    clearProgress: () => void
    isInteractive: boolean
}

const isApproved = (value: string): boolean => {
    const normalized = value.trim().toLowerCase()

    return normalized === 'y' || normalized === 'yes'
}

const renderPatchApproval = (request: PatchApprovalView, isInteractive: boolean): string =>
    [
        `Patch proposal: ${request.relativePath}`,
        request.diff,
        isInteractive ? '' : `${PATCH_APPROVAL_PROMPT}\n`,
    ].join('\n')

export const createTerminalPatchApprover = ({
    input,
    write,
    clearProgress,
    isInteractive,
}: CreateTerminalPatchApproverOptions): PatchApprover => {
    return async (request, { signal } = {}): Promise<PatchApprovalDecision> => {
        if (signal?.aborted) return 'aborted'
        clearProgress()
        write(renderPatchApproval(request, isInteractive))
        if (signal?.aborted) return 'aborted'

        if (!isInteractive || input === undefined) {
            return 'denied'
        }

        try {
            const response = await input.readLine(
                PATCH_APPROVAL_PROMPT,
                signal === undefined ? undefined : { signal }
            )
            if (signal?.aborted) return 'aborted'

            return response !== null && isApproved(response) ? 'approved' : 'denied'
        } catch (error) {
            return error instanceof LineReadAbortedError || signal?.aborted ? 'aborted' : 'denied'
        }
    }
}
