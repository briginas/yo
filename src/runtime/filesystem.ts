import { readFile as fsReadFile, readdir, stat } from 'node:fs/promises'
import { basename, join, matchesGlob, relative, sep } from 'node:path'

import type { PermissionDeniedReason } from './permissions.ts'
import type { ListFilesArguments, ReadFileArguments, SearchCodeArguments } from './tools.ts'
import { resolveWorkspacePath } from './workspace.ts'

export type ListFilesResult =
    | {
          status: 'success'
          entries: string[]
      }
    | {
          status: 'denied'
          reason: Extract<PermissionDeniedReason, 'outside_workspace' | 'sensitive_path'>
      }

export type SearchCodeResult =
    | {
          status: 'success'
          matches: string[]
      }
    | {
          status: 'denied'
          reason: Extract<PermissionDeniedReason, 'outside_workspace' | 'sensitive_path'>
      }

export type ReadFileResult =
    | {
          status: 'success'
          content: string
      }
    | {
          status: 'denied'
          reason: Extract<PermissionDeniedReason, 'outside_workspace' | 'sensitive_path'>
      }

type SearchCandidate = {
    absolutePath: string
    relativePath: string
}

const toPosixPath = (path: string): string => path.split(sep).join('/')

const textDecoder = new TextDecoder('utf-8', { fatal: true })

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
    arguments_: ListFilesArguments
): Promise<ListFilesResult> => {
    const directoryDecision = await resolveWorkspacePath(workspaceRoot, arguments_.path)

    if (directoryDecision.decision === 'deny') {
        return {
            status: 'denied',
            reason: directoryDecision.reason,
        }
    }

    const directoryStats = await stat(directoryDecision.absolutePath)

    if (!directoryStats.isDirectory()) {
        throw new Error(`List path must be a directory: ${directoryDecision.relativePath}`)
    }

    const listedPaths: string[] = []

    const visitDirectory = async (absoluteDirectoryPath: string): Promise<void> => {
        const entries = await readdir(absoluteDirectoryPath, { withFileTypes: true })

        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.isSymbolicLink()) {
                continue
            }

            const entryDecision = await resolveWorkspacePath(
                workspaceRoot,
                join(absoluteDirectoryPath, entry.name)
            )

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

            if (arguments_.glob !== undefined && isDirectory) {
                await visitDirectory(entryDecision.absolutePath)
            }
        }
    }

    await visitDirectory(directoryDecision.absolutePath)

    listedPaths.sort(comparePaths)

    return {
        status: 'success',
        entries:
            arguments_.limit === undefined ? listedPaths : listedPaths.slice(0, arguments_.limit),
    }
}

export const searchCode = async (
    workspaceRoot: string,
    arguments_: SearchCodeArguments
): Promise<SearchCodeResult> => {
    const searchPathDecision = await resolveWorkspacePath(workspaceRoot, arguments_.path ?? '.')

    if (searchPathDecision.decision === 'deny') {
        return {
            status: 'denied',
            reason: searchPathDecision.reason,
        }
    }

    const searchPathStats = await stat(searchPathDecision.absolutePath)
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
        const entries = await readdir(absoluteDirectoryPath, { withFileTypes: true })

        for (const entry of entries) {
            if (entry.name === 'node_modules' || entry.isSymbolicLink()) {
                continue
            }

            const entryDecision = await resolveWorkspacePath(
                workspaceRoot,
                join(absoluteDirectoryPath, entry.name)
            )

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

    const matches: string[] = []

    for (const candidate of searchCandidates) {
        const contents = await fsReadFile(candidate.absolutePath)

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
            if (!line.includes(arguments_.query)) {
                continue
            }

            matches.push(`${candidate.relativePath}:${lineIndex + 1}:${line}`)

            if (arguments_.limit !== undefined && matches.length >= arguments_.limit) {
                return {
                    status: 'success',
                    matches,
                }
            }
        }
    }

    return {
        status: 'success',
        matches,
    }
}

export const readFile = async (
    workspaceRoot: string,
    arguments_: ReadFileArguments
): Promise<ReadFileResult> => {
    const fileDecision = await resolveWorkspacePath(workspaceRoot, arguments_.path)

    if (fileDecision.decision === 'deny') {
        return {
            status: 'denied',
            reason: fileDecision.reason,
        }
    }

    const fileStats = await stat(fileDecision.absolutePath)

    if (!fileStats.isFile()) {
        throw new Error(`Read path must be a file: ${fileDecision.relativePath}`)
    }

    const contents = await fsReadFile(fileDecision.absolutePath)

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
    const selectedLines = lines
        .slice(startLine - 1, endLine)
        .map((line, index) => `${startLine + index}:${line}`)

    return {
        status: 'success',
        content: selectedLines.join('\n'),
    }
}
