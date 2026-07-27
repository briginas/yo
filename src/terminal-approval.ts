import type { LineInput } from './line-input.ts'
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
        `${PATCH_APPROVAL_PROMPT}${isInteractive ? '' : '\n'}`,
    ].join('\n')

export const createTerminalPatchApprover = ({
    input,
    write,
    clearProgress,
    isInteractive,
}: CreateTerminalPatchApproverOptions): PatchApprover => {
    return async (request): Promise<PatchApprovalDecision> => {
        clearProgress()
        write(renderPatchApproval(request, isInteractive))

        if (!isInteractive || input === undefined) {
            return 'denied'
        }

        try {
            const response = await input.readLine('')

            return response !== null && isApproved(response) ? 'approved' : 'denied'
        } catch {
            return 'denied'
        }
    }
}
