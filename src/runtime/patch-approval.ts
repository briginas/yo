import type {
    PatchApprovalDecision,
    PatchApprovalView,
    PatchApprover,
    PatchProposal,
} from './patch-contracts.ts'

const isPatchApprovalDecision = (value: unknown): value is PatchApprovalDecision =>
    value === 'approved' || value === 'denied' || value === 'aborted'

const createApprovalView = (proposal: PatchProposal): PatchApprovalView =>
    Object.freeze({
        id: proposal.id,
        relativePath: proposal.relativePath,
        baseHash: proposal.baseHash,
        nextHash: proposal.nextHash,
        diff: proposal.diff,
        unifiedPatch: proposal.unifiedPatch,
        addedLineCount: proposal.addedLineCount,
        removedLineCount: proposal.removedLineCount,
    })

export const requestPatchApproval = async (
    proposal: PatchProposal,
    approver?: PatchApprover
): Promise<PatchApprovalDecision> => {
    if (approver === undefined) {
        return 'denied'
    }

    try {
        const decision: unknown = await approver(createApprovalView(proposal))

        return isPatchApprovalDecision(decision) ? decision : 'denied'
    } catch {
        return 'denied'
    }
}
