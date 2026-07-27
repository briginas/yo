import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { PATCH_MAX_FILE_BYTES, type PatchEdit, type PatchProposal } from './patch-contracts.ts'
import { isSensitivePath } from './permissions.ts'
import { preparePatchTransform } from './patch-transform.ts'

type PatchTargetStats = Readonly<{
    mode: number
    isSymbolicLink: () => boolean
    isFile: () => boolean
}>

export type PatchPreparationOperations = Readonly<{
    lstat: (path: string) => Promise<PatchTargetStats>
    realpath: (path: string) => Promise<string>
    readFile: (path: string, maxBytes: number) => Promise<Uint8Array>
    randomUUID: () => string
}>

export type PatchTarget = Readonly<{
    absolutePath: string
    relativePath: string
    mode: number
}>

export type PatchPreparationErrorCode =
    | 'outside_workspace'
    | 'sensitive_path'
    | 'missing_path'
    | 'symlink_path'
    | 'non_regular_file'
    | 'source_too_large'
    | 'filesystem_error'

export class PatchPreparationError extends Error {
    readonly code: PatchPreparationErrorCode

    constructor(code: PatchPreparationErrorCode, message: string) {
        super(message)
        this.name = 'PatchPreparationError'
        this.code = code
    }
}

const isPathInsideWorkspace = (workspaceRoot: string, absolutePath: string): boolean => {
    const relativePath = relative(workspaceRoot, absolutePath)

    return (
        relativePath === '' ||
        (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
    )
}

const toWorkspaceRelativePath = (workspaceRoot: string, absolutePath: string): string => {
    const relativePath = relative(workspaceRoot, absolutePath)

    return relativePath === '' ? '.' : relativePath.split(sep).join('/')
}

const fail = (code: PatchPreparationErrorCode, message: string): never => {
    throw new PatchPreparationError(code, message)
}

const isMissingPathError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const asFilesystemError = (error: unknown, action: string): never => {
    if (error instanceof PatchPreparationError) {
        throw error
    }
    if (isMissingPathError(error)) {
        return fail('missing_path', 'Patch target must already exist')
    }

    return fail('filesystem_error', `Unable to ${action} patch target`)
}

const readBoundedFile = async (path: string, maxBytes: number): Promise<Uint8Array> => {
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const buffer = Buffer.allocUnsafe(maxBytes + 1)
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)

        if (bytesRead > maxBytes) {
            return fail('source_too_large', `Source file must not exceed ${maxBytes} bytes`)
        }

        return buffer.subarray(0, bytesRead)
    } finally {
        await handle?.close()
    }
}

const defaultOperations: PatchPreparationOperations = {
    lstat,
    realpath,
    readFile: readBoundedFile,
    randomUUID,
}

const freezeEdits = (edits: readonly PatchEdit[]): readonly PatchEdit[] =>
    Object.freeze(edits.map((edit) => Object.freeze({ ...edit })))

const getPathComponents = (workspaceRoot: string, absolutePath: string): string[] => {
    const relativePath = relative(workspaceRoot, absolutePath)
    const segments = relativePath === '' ? [] : relativePath.split(sep)

    return segments.map((_, index) => resolve(workspaceRoot, ...segments.slice(0, index + 1)))
}

export const resolvePatchTarget = async (
    workspaceRoot: string,
    requestedPath: string,
    operations: PatchPreparationOperations = defaultOperations
): Promise<PatchTarget> => {
    const absolutePath = resolve(workspaceRoot, requestedPath)

    if (!isPathInsideWorkspace(workspaceRoot, absolutePath)) {
        return fail('outside_workspace', 'Patch target must be inside the approved workspace')
    }

    const requestedRelativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath)
    if (isSensitivePath(requestedRelativePath)) {
        return fail('sensitive_path', 'Patch target is a sensitive path')
    }

    const components = getPathComponents(workspaceRoot, absolutePath)
    let targetStats: PatchTargetStats | undefined
    for (const component of components) {
        let stats: PatchTargetStats
        try {
            stats = await operations.lstat(component)
        } catch (error) {
            return asFilesystemError(error, 'inspect')
        }

        if (stats.isSymbolicLink()) {
            return fail('symlink_path', 'Patch target path must not contain symbolic links')
        }
        targetStats = stats
    }

    if (targetStats === undefined || !targetStats.isFile()) {
        return fail('non_regular_file', 'Patch target must be an existing regular file')
    }

    let canonicalPath = ''
    try {
        canonicalPath = await operations.realpath(absolutePath)
    } catch (error) {
        return asFilesystemError(error, 'resolve')
    }

    if (!isPathInsideWorkspace(workspaceRoot, canonicalPath)) {
        return fail('outside_workspace', 'Patch target must be inside the approved workspace')
    }

    const canonicalRelativePath = toWorkspaceRelativePath(workspaceRoot, canonicalPath)
    if (isSensitivePath(canonicalRelativePath)) {
        return fail('sensitive_path', 'Patch target is a sensitive path')
    }

    return Object.freeze({
        absolutePath,
        relativePath: canonicalRelativePath,
        mode: targetStats.mode & 0o7777,
    })
}

export const preparePatchProposal = async (
    workspaceRoot: string,
    path: string,
    edits: readonly PatchEdit[],
    operations: PatchPreparationOperations = defaultOperations
): Promise<PatchProposal> => {
    const target = await resolvePatchTarget(workspaceRoot, path, operations)
    let sourceBytes: Uint8Array
    try {
        sourceBytes = await operations.readFile(target.absolutePath, PATCH_MAX_FILE_BYTES)
    } catch (error) {
        return asFilesystemError(error, 'read')
    }

    if (sourceBytes.byteLength > PATCH_MAX_FILE_BYTES) {
        return fail('source_too_large', `Source file must not exceed ${PATCH_MAX_FILE_BYTES} bytes`)
    }

    const transform = preparePatchTransform(sourceBytes, target.relativePath, edits)
    const proposal: PatchProposal = {
        id: operations.randomUUID(),
        absolutePath: target.absolutePath,
        relativePath: target.relativePath,
        mode: target.mode,
        edits: freezeEdits(edits),
        nextContent: transform.nextContent,
        baseHash: transform.baseHash,
        nextHash: transform.nextHash,
        diff: transform.diff,
        unifiedPatch: transform.unifiedPatch,
        addedLineCount: transform.addedLineCount,
        removedLineCount: transform.removedLineCount,
    }

    return Object.freeze(proposal)
}
