import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { PATCH_MAX_FILE_BYTES, type PatchConflict, type PatchProposal } from './patch-contracts.ts'
import {
    resolvePatchTarget,
    readBoundedFile,
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
    resolveTarget: (
        workspaceRoot: string,
        path: string,
        signal?: AbortSignal
    ) => Promise<PatchTarget>
    readFile: (path: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>
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

const defaultOperations: PatchApplicationOperations = {
    resolveTarget: (workspaceRoot, path, signal) =>
        resolvePatchTarget(workspaceRoot, path, undefined, signal),
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

// The dispatcher owns consent. Stop before rename, but once replacement begins its actual
// result is authoritative even while cancellation and temporary-file cleanup are settling.
export const applyPatchProposal = async (
    workspaceRoot: string,
    proposal: PatchProposal,
    options: ApplyPatchProposalOptions = {}
): Promise<PatchApplicationOutcome> => {
    const operations = options.operations ?? defaultOperations
    let temporaryPath: string | undefined
    let temporaryFile: TemporaryFile | undefined
    let renamed = false
    let renameStarted = false

    try {
        assertNotAborted(options.signal)
        const target = await operations.resolveTarget(
            workspaceRoot,
            proposal.relativePath,
            options.signal
        )
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

        const sourceBytes = await operations.readFile(
            target.absolutePath,
            PATCH_MAX_FILE_BYTES,
            options.signal
        )
        assertNotAborted(options.signal)

        if (sourceBytes.byteLength > PATCH_MAX_FILE_BYTES) {
            throw new PatchApplicationError('filesystem_error', 'Unable to apply approved patch')
        }
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

        renameStarted = true
        await operations.rename(temporaryPath, target.absolutePath)
        renamed = true
        return { status: 'applied' }
    } catch (error) {
        if (renameStarted) {
            throw new PatchApplicationError('filesystem_error', 'Unable to apply approved patch')
        }
        if (isAborted(options.signal)) {
            return { status: 'aborted' }
        }
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
    options: ApplyPatchProposalOptions = {}
): Promise<PatchApplicationOutcome | Readonly<{ status: 'timeout' }>> => {
    const controller = new AbortController()
    let stopCause: 'timeout' | 'aborted' | undefined
    const requestStop = (cause: 'timeout' | 'aborted'): void => {
        if (stopCause === undefined) {
            stopCause = cause
            controller.abort()
        }
    }
    const onAbort = (): void => requestStop('aborted')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => requestStop('timeout'), timeoutMs)

    try {
        if (options.signal?.aborted) requestStop('aborted')
        const outcome = await applyPatchProposal(workspaceRoot, proposal, {
            ...options,
            signal: controller.signal,
        })

        // Only a stopped pre-rename outcome is classified by the first stop cause.
        // Committed conflicts, failures, and initiated rename outcomes are preserved.
        return outcome.status === 'aborted' && stopCause !== undefined
            ? { status: stopCause }
            : outcome
    } finally {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
    }
}

export type { PatchPreparationOperations }
