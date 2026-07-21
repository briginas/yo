import { readdir, stat } from 'node:fs/promises'
import { join, matchesGlob, relative, sep } from 'node:path'

import type { PermissionDeniedReason } from './permissions.ts'
import type { ListFilesArguments } from './tools.ts'
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

const toPosixPath = (path: string): string => path.split(sep).join('/')

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
