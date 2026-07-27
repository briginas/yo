import { z } from 'zod'

export const PATCH_MAX_EDITS = 20
export const PATCH_MAX_ARGUMENT_BYTES = 50 * 1024
export const PATCH_MAX_FILE_BYTES = 1024 * 1024
export const PATCH_MAX_DIFF_BYTES = 50 * 1024

const patchEditSchema = z
    .object({
        oldText: z.string().min(1),
        // An empty replacement is a valid exact deletion. Only the text to be matched must exist.
        newText: z.string(),
    })
    .strict()

export const proposePatchArgumentsSchema = z
    .object({
        path: z.string().min(1),
        edits: z.array(patchEditSchema).min(1).max(PATCH_MAX_EDITS),
    })
    .strict()
    .check((payload) => {
        const argumentBytes = payload.value.edits.reduce(
            (total, edit) =>
                total +
                Buffer.byteLength(edit.oldText, 'utf8') +
                Buffer.byteLength(edit.newText, 'utf8'),
            0
        )

        if (argumentBytes > PATCH_MAX_ARGUMENT_BYTES) {
            payload.issues.push({
                code: 'custom',
                message: `Combined edit text must not exceed ${PATCH_MAX_ARGUMENT_BYTES} UTF-8 bytes`,
                path: ['edits'],
                input: payload.value,
            })
        }
    })

export type PatchEdit = Readonly<z.infer<typeof patchEditSchema>>

export type ProposePatchArguments = Readonly<{
    path: string
    edits: readonly PatchEdit[]
}>

export type PatchApprovalDecision = 'approved' | 'denied' | 'aborted'

export type PatchApprovalView = Readonly<{
    id: string
    relativePath: string
    baseHash: string
    nextHash: string
    diff: string
    unifiedPatch: string
    addedLineCount: number
    removedLineCount: number
}>

export type PatchProposal = PatchApprovalView &
    Readonly<{
        absolutePath: string
        edits: readonly PatchEdit[]
        nextContent: string
    }>

export type PatchConflict = Readonly<{
    code: 'base_changed' | 'proposal_changed'
    message: string
}>

export type PatchPreparationOutcome =
    | Readonly<{
          status: 'prepared'
          proposal: PatchProposal
      }>
    | Readonly<{
          status: 'conflict'
          conflict: PatchConflict
      }>
