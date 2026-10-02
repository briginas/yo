import type { Dirent, Stats } from 'node:fs'
import { readFile as fsReadFile, readdir, stat } from 'node:fs/promises'
import { basename, join, matchesGlob, relative, sep } from 'node:path'

import {
    FILESYSTEM_OUTPUT_MAX_BYTES,
    FILESYSTEM_OUTPUT_MAX_LINES,
    LIST_FILES_DEFAULT_LIMIT,
    SEARCH_CODE_DEFAULT_LIMIT,
} from './filesystem-limits.ts'
import type { PermissionDeniedReason } from './permissions.ts'
import type {
    ListFilesArguments,
    ReadFileArguments,
    SearchCodeArguments,
    ToolResultMetadata,
    ToolResultTruncation,
} from './tools.ts'
import { checkOperationSignal } from './settled-operation.ts'
import { resolveWorkspacePath } from './workspace.ts'

// Trusted operation injection keeps cancellation boundaries testable without changing model schemas.
export type FilesystemExecutionOptions = Readonly<{
    signal?: AbortSignal
    operations?: Readonly<{
        stat: (path: string) => Promise<Stats>
        readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>
        readFile: (path: string, options: { signal?: AbortSignal | undefined }) => Promise<Buffer>
    }>
}>

const defaultOperations: NonNullable<FilesystemExecutionOptions['operations']> = {
    stat,
    readdir,
    readFile: fsReadFile,
}

export type ListFilesResult =
    | {
          status: 'success'
          entries: string[]
          metadata: ToolResultMetadata
      }
    | {
          status: 'denied'
          reason: Extract<PermissionDeniedReason, 'outside_workspace' | 'sensitive_path'>
      }

export type SearchCodeResult =
    | {
          status: 'success'
          matches: string[]
          metadata: ToolResultMetadata
      }
    | {
          status: 'denied'
          reason: Extract<PermissionDeniedReason, 'outside_workspace' | 'sensitive_path'>
      }

export type ReadFileResult =
    | {
          status: 'success'
          content: string
          metadata: ToolResultMetadata
      }
    | {
          status: 'denied'
          reason: Extract<PermissionDeniedReason, 'outside_workspace' | 'sensitive_path'>
      }

type SearchCandidate = {
    absolutePath: string
    relativePath: string
}

type OutputItemLimit = {
    reason: Extract<ToolResultTruncation['reason'], 'line_limit' | 'result_limit'>
    limit: number
}

type OutputAccumulator = {
    items: string[]
    add: (item: string) => ToolResultMetadata | null
    complete: () => ToolResultMetadata
}

const toPosixPath = (path: string): string => path.split(sep).join('/')

const textDecoder = new TextDecoder('utf-8', { fatal: true })

const completeOutputMetadata = (): ToolResultMetadata => ({
    truncated: false,
    truncation: null,
})

// Rejecting only the next complete item distinguishes exact-limit output from truncation.
// Byte accounting includes the newlines used when the retained items are serialized.
const createOutputAccumulator = (itemLimit: OutputItemLimit): OutputAccumulator => {
    const items: string[] = []
    let outputBytes = 0

    return {
        items,
        add: (item) => {
            if (items.length >= itemLimit.limit) {
                return {
                    truncated: true,
                    truncation: {
                        reason: itemLimit.reason,
                        limit: itemLimit.limit,
                        observed: items.length + 1,
                    },
                }
            }

            const observedBytes =
                outputBytes + (items.length === 0 ? 0 : 1) + Buffer.byteLength(item, 'utf8')

            if (observedBytes > FILESYSTEM_OUTPUT_MAX_BYTES) {
                return {
                    truncated: true,
                    truncation: {
                        reason: 'byte_limit',
                        limit: FILESYSTEM_OUTPUT_MAX_BYTES,
                        observed: observedBytes,
                    },
                }
            }

            items.push(item)
            outputBytes = observedBytes

            return null
        },
        complete: completeOutputMetadata,
    }
}

const comparePaths = (left: string, right: string): number => {
    if (left < right) {
        return -1
    }

    if (left > right) {
        return 1
    }

    return 0
}

export const listFiles = async (
    workspaceRoot: string,
    arguments_: ListFilesArguments,
    options: FilesystemExecutionOptions = {}
): Promise<ListFilesResult> => {
    const { signal } = options
    const operations = options.operations ?? defaultOperations
    checkOperationSignal(signal)
    const directoryDecision = await resolveWorkspacePath(workspaceRoot, arguments_.path, signal)

    if (directoryDecision.decision === 'deny') {
        return {
            status: 'denied',
            reason: directoryDecision.reason,
        }
    }

    checkOperationSignal(signal)
    const directoryStats = await operations.stat(directoryDecision.absolutePath)

    checkOperationSignal(signal)
    if (!directoryStats.isDirectory()) {
        throw new Error(`List path must be a directory: ${directoryDecision.relativePath}`)
    }

    const listedPaths: string[] = []

    const visitDirectory = async (absoluteDirectoryPath: string): Promise<void> => {
        checkOperationSignal(signal)
        const entries = await operations.readdir(absoluteDirectoryPath, { withFileTypes: true })

        checkOperationSignal(signal)
        for (const entry of entries) {
            checkOperationSignal(signal)
            // Discovery avoids vendor-tree expansion and symlink cycles or aliases. Explicit
            // symlink paths are still canonicalized safely by resolveWorkspacePath.
            if (entry.name === 'node_modules' || entry.isSymbolicLink()) {
                continue
            }

            const entryDecision = await resolveWorkspacePath(
                workspaceRoot,
                join(absoluteDirectoryPath, entry.name),
                signal
            )

            checkOperationSignal(signal)
            if (entryDecision.decision === 'deny') {
                continue
            }

            const isDirectory = entry.isDirectory()

            if (!isDirectory && !entry.isFile()) {
                continue
            }

            const pathFromRequestedDirectory = toPosixPath(
                relative(directoryDecision.absolutePath, entryDecision.absolutePath)
            )

            if (
                arguments_.glob === undefined ||
                matchesGlob(pathFromRequestedDirectory, arguments_.glob)
            ) {
                listedPaths.push(
                    isDirectory ? `${entryDecision.relativePath}/` : entryDecision.relativePath
                )
            }

            // A glob opts into recursive matching; without one, list only immediate entries.
            if (arguments_.glob !== undefined && isDirectory) {
                await visitDirectory(entryDecision.absolutePath)
            }
        }
    }

    await visitDirectory(directoryDecision.absolutePath)

    listedPaths.sort(comparePaths)
    const limit = arguments_.limit ?? LIST_FILES_DEFAULT_LIMIT
    const output = createOutputAccumulator({
        reason: 'result_limit',
        limit,
    })

    for (const listedPath of listedPaths) {
        checkOperationSignal(signal)
        const truncationMetadata = output.add(listedPath)

        if (truncationMetadata !== null) {
            return {
                status: 'success',
                entries: output.items,
                metadata: truncationMetadata,
            }
        }
    }

    return {
        status: 'success',
        entries: output.items,
        metadata: output.complete(),
    }
}

export const searchCode = async (
    workspaceRoot: string,
    arguments_: SearchCodeArguments,
    options: FilesystemExecutionOptions = {}
): Promise<SearchCodeResult> => {
    const { signal } = options
    const operations = options.operations ?? defaultOperations
    checkOperationSignal(signal)
    const searchPathDecision = await resolveWorkspacePath(
        workspaceRoot,
        arguments_.path ?? '.',
        signal
    )

    if (searchPathDecision.decision === 'deny') {
        return {
            status: 'denied',
            reason: searchPathDecision.reason,
        }
    }

    checkOperationSignal(signal)
    const searchPathStats = await operations.stat(searchPathDecision.absolutePath)
    checkOperationSignal(signal)
    const searchCandidates: SearchCandidate[] = []

    const addFile = (absolutePath: string, relativePath: string): void => {
        const pathFromSearchRoot = searchPathStats.isDirectory()
            ? toPosixPath(relative(searchPathDecision.absolutePath, absolutePath))
            : basename(absolutePath)

        if (arguments_.glob === undefined || matchesGlob(pathFromSearchRoot, arguments_.glob)) {
            searchCandidates.push({
                absolutePath,
                relativePath,
            })
        }
    }

    const visitDirectory = async (absoluteDirectoryPath: string): Promise<void> => {
        checkOperationSignal(signal)
        const entries = await operations.readdir(absoluteDirectoryPath, { withFileTypes: true })

        checkOperationSignal(signal)
        for (const entry of entries) {
            checkOperationSignal(signal)
            // Discovery avoids vendor-tree expansion and symlink cycles or aliases. Explicit
            // symlink paths are still canonicalized safely by resolveWorkspacePath.
            if (entry.name === 'node_modules' || entry.isSymbolicLink()) {
                continue
            }

            const entryDecision = await resolveWorkspacePath(
                workspaceRoot,
                join(absoluteDirectoryPath, entry.name),
                signal
            )

            checkOperationSignal(signal)
            if (entryDecision.decision === 'deny') {
                continue
            }

            if (entry.isDirectory()) {
                await visitDirectory(entryDecision.absolutePath)
                continue
            }

            if (entry.isFile()) {
                addFile(entryDecision.absolutePath, entryDecision.relativePath)
            }
        }
    }

    if (searchPathStats.isDirectory()) {
        await visitDirectory(searchPathDecision.absolutePath)
    } else if (searchPathStats.isFile()) {
        addFile(searchPathDecision.absolutePath, searchPathDecision.relativePath)
    } else {
        throw new Error(
            `Search path must be a file or directory: ${searchPathDecision.relativePath}`
        )
    }

    searchCandidates.sort((left, right) => comparePaths(left.relativePath, right.relativePath))

    const limit = arguments_.limit ?? SEARCH_CODE_DEFAULT_LIMIT
    const output = createOutputAccumulator({
        reason: 'result_limit',
        limit,
    })

    for (const candidate of searchCandidates) {
        checkOperationSignal(signal)
        // Search is a best-effort text scan, so non-text candidates are skipped. readFile
        // reports the same conditions when the caller explicitly requests that file.
        const contents = await operations.readFile(candidate.absolutePath, { signal })
        checkOperationSignal(signal)

        if (contents.includes(0)) {
            continue
        }

        let text: string

        try {
            text = textDecoder.decode(contents)
        } catch {
            continue
        }

        const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')

        for (const [lineIndex, line] of lines.entries()) {
            checkOperationSignal(signal)
            if (!line.includes(arguments_.query)) {
                continue
            }

            const truncationMetadata = output.add(
                `${candidate.relativePath}:${lineIndex + 1}:${line}`
            )

            if (truncationMetadata !== null) {
                return {
                    status: 'success',
                    matches: output.items,
                    metadata: truncationMetadata,
                }
            }
        }
    }

    return {
        status: 'success',
        matches: output.items,
        metadata: output.complete(),
    }
}

export const readFile = async (
    workspaceRoot: string,
    arguments_: ReadFileArguments,
    options: FilesystemExecutionOptions = {}
): Promise<ReadFileResult> => {
    const { signal } = options
    const operations = options.operations ?? defaultOperations
    checkOperationSignal(signal)
    const fileDecision = await resolveWorkspacePath(workspaceRoot, arguments_.path, signal)

    if (fileDecision.decision === 'deny') {
        return {
            status: 'denied',
            reason: fileDecision.reason,
        }
    }

    checkOperationSignal(signal)
    const fileStats = await operations.stat(fileDecision.absolutePath)

    checkOperationSignal(signal)
    if (!fileStats.isFile()) {
        throw new Error(`Read path must be a file: ${fileDecision.relativePath}`)
    }

    const contents = await operations.readFile(fileDecision.absolutePath, { signal })
    checkOperationSignal(signal)

    if (contents.includes(0)) {
        throw new Error(`Cannot read binary file: ${fileDecision.relativePath}`)
    }

    let text: string

    try {
        text = textDecoder.decode(contents)
    } catch {
        throw new Error(`Cannot decode file as UTF-8: ${fileDecision.relativePath}`)
    }

    const normalizedText = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')

    if (normalizedText.length === 0) {
        if (arguments_.startLine !== undefined && arguments_.startLine > 1) {
            throw new Error(
                `Start line ${arguments_.startLine} is beyond end of file (0 lines): ${fileDecision.relativePath}`
            )
        }

        return {
            status: 'success',
            content: '',
            metadata: completeOutputMetadata(),
        }
    }

    const lines = normalizedText.split('\n')

    if (lines.at(-1) === '') {
        lines.pop()
    }

    const startLine = arguments_.startLine ?? 1

    if (startLine > lines.length) {
        throw new Error(
            `Start line ${startLine} is beyond end of file (${lines.length} lines): ${fileDecision.relativePath}`
        )
    }

    const endLine = Math.min(arguments_.endLine ?? lines.length, lines.length)
    const selectedLines = lines.slice(startLine - 1, endLine)
    const output = createOutputAccumulator({
        reason: 'line_limit',
        limit: FILESYSTEM_OUTPUT_MAX_LINES,
    })

    for (const [lineIndex, line] of selectedLines.entries()) {
        checkOperationSignal(signal)
        const truncationMetadata = output.add(`${startLine + lineIndex}:${line}`)

        if (truncationMetadata !== null) {
            return {
                status: 'success',
                content: output.items.join('\n'),
                metadata: truncationMetadata,
            }
        }
    }

    return {
        status: 'success',
        content: output.items.join('\n'),
        metadata: output.complete(),
    }
}
