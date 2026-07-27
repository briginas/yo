import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { PATCH_MAX_FILE_BYTES, type PatchConflict, type PatchProposal } from './patch-contracts.ts'
import {
    resolvePatchTarget,
    type PatchPreparationOperations,
    type PatchTarget,
} from './patch-preparer.ts'
import { preparePatchTransform } from './patch-transform.ts'

export type PatchApplicationErrorCode = 'filesystem_error' | 'aborted'

export class PatchApplicationError extends Error {
    readonly code: PatchApplicationErrorCode

    constructor(code: PatchApplicationErrorCode, message: string) {
        super(message)
        this.name = 'PatchApplicationError'
        this.code = code
    }
}

export type PatchApplicationOutcome =
    | Readonly<{ status: 'applied' }>
    | Readonly<{ status: 'conflict'; conflict: PatchConflict }>
    | Readonly<{ status: 'aborted' }>

type TemporaryFile = Readonly<{
    chmod: (mode: number) => Promise<void>
    writeFile: (content: string) => Promise<void>
    sync: () => Promise<void>
    close: () => Promise<void>
}>

export type PatchApplicationOperations = Readonly<{
    resolveTarget: (workspaceRoot: string, path: string) => Promise<PatchTarget>
    readFile: (path: string, maxBytes: number) => Promise<Uint8Array>
    openTemporaryFile: (path: string, mode: number) => Promise<TemporaryFile>
    rename: (from: string, to: string) => Promise<void>
    unlink: (path: string) => Promise<void>
    randomUUID: () => string
}>

export type ApplyPatchProposalOptions = Readonly<{
    signal?: AbortSignal
    operations?: PatchApplicationOperations
}>

const hashBytes = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

const readBoundedFile = async (path: string, maxBytes: number): Promise<Uint8Array> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const buffer = Buffer.allocUnsafe(maxBytes + 1)
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)

        if (bytesRead > maxBytes) {
            throw new PatchApplicationError(
                'filesystem_error',
                `Patch source must not exceed ${maxBytes} bytes`
            )
        }

        return buffer.subarray(0, bytesRead)
    } finally {
        await handle?.close()
    }
}

const defaultOperations: PatchApplicationOperations = {
    resolveTarget: (workspaceRoot, path) => resolvePatchTarget(workspaceRoot, path),
    readFile: readBoundedFile,
    openTemporaryFile: async (path, mode) =>
        open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode),
    rename,
    unlink,
    randomUUID,
}

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true

const assertNotAborted = (signal: AbortSignal | undefined): void => {
    if (isAborted(signal)) {
        throw new PatchApplicationError('aborted', 'Patch application was aborted before rename')
    }
}

const conflict = (code: PatchConflict['code'], message: string): PatchApplicationOutcome => ({
    status: 'conflict',
    conflict: { code, message },
})

const toApplicationError = (error: unknown): PatchApplicationError => {
    if (error instanceof PatchApplicationError) {
        return error
    }

    return new PatchApplicationError('filesystem_error', 'Unable to apply approved patch')
}

const createTemporaryPath = (proposal: PatchProposal, id: string): string =>
    join(dirname(proposal.absolutePath), `.${basename(proposal.absolutePath)}.yo-patch-${id}`)

// This remains internal until the specialized patch dispatcher supplies approval, lifecycle
// events, and a timeout controller. The signal is checked only after each temporary-file await,
// so an aborted call always settles and cleans up before it can report completion.
export const applyPatchProposal = async (
    workspaceRoot: string,
    proposal: PatchProposal,
    options: ApplyPatchProposalOptions = {}
): Promise<PatchApplicationOutcome> => {
    const operations = options.operations ?? defaultOperations
    let temporaryPath: string | undefined
    let temporaryFile: TemporaryFile | undefined
    let renamed = false

    try {
        assertNotAborted(options.signal)
        const target = await operations.resolveTarget(workspaceRoot, proposal.relativePath)
        assertNotAborted(options.signal)

        if (
            target.absolutePath !== proposal.absolutePath ||
            target.relativePath !== proposal.relativePath ||
            target.mode !== proposal.mode
        ) {
            return conflict(
                'proposal_changed',
                'Approved patch target no longer matches the proposal'
            )
        }

        const sourceBytes = await operations.readFile(target.absolutePath, PATCH_MAX_FILE_BYTES)
        assertNotAborted(options.signal)

        if (hashBytes(sourceBytes) !== proposal.baseHash) {
            return conflict('base_changed', 'Patch target changed after approval')
        }

        const transform = preparePatchTransform(sourceBytes, proposal.relativePath, proposal.edits)
        if (
            transform.nextHash !== proposal.nextHash ||
            transform.diff !== proposal.diff ||
            transform.unifiedPatch !== proposal.unifiedPatch ||
            transform.nextContent !== proposal.nextContent
        ) {
            return conflict(
                'proposal_changed',
                'Approved patch result no longer matches the proposal'
            )
        }

        assertNotAborted(options.signal)
        temporaryPath = createTemporaryPath(proposal, operations.randomUUID())
        temporaryFile = await operations.openTemporaryFile(temporaryPath, proposal.mode)
        assertNotAborted(options.signal)

        await temporaryFile.chmod(proposal.mode)
        assertNotAborted(options.signal)
        await temporaryFile.writeFile(proposal.nextContent)
        assertNotAborted(options.signal)
        await temporaryFile.sync()
        assertNotAborted(options.signal)
        await temporaryFile.close()
        temporaryFile = undefined
        assertNotAborted(options.signal)

        await operations.rename(temporaryPath, target.absolutePath)
        renamed = true
        return { status: 'applied' }
    } catch (error) {
        const applicationError = toApplicationError(error)

        if (applicationError.code === 'aborted') {
            return { status: 'aborted' }
        }

        throw applicationError
    } finally {
        try {
            await temporaryFile?.close()
        } catch {
            // The original operation error is the only safe observable failure.
        }

        if (temporaryPath !== undefined && !renamed) {
            try {
                await operations.unlink(temporaryPath)
            } catch {
                // Cleanup is best effort and cannot widen the approved mutation.
            }
        }
    }
}

export const applyPatchProposalWithTimeout = async (
    workspaceRoot: string,
    proposal: PatchProposal,
    timeoutMs: number,
    options: Omit<ApplyPatchProposalOptions, 'signal'> = {}
): Promise<PatchApplicationOutcome | Readonly<{ status: 'timeout' }>> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const outcome = await applyPatchProposal(workspaceRoot, proposal, {
            ...options,
            signal: controller.signal,
        })

        return controller.signal.aborted && outcome.status !== 'applied'
            ? { status: 'timeout' }
            : outcome
    } finally {
        clearTimeout(timeout)
    }
}

export type { PatchPreparationOperations }
