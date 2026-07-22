import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isSensitivePath, type WorkspacePathPermissionDecision } from './permissions.ts'

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

export const canonicalizeWorkspaceRoot = async (cwd: string): Promise<string> => {
    if (cwd.length === 0) {
        throw new Error('Workspace root must not be empty')
    }

    const workspaceRoot = await realpath(resolve(cwd))
    const workspaceStats = await stat(workspaceRoot)

    if (!workspaceStats.isDirectory()) {
        throw new Error(`Workspace root must be a directory: ${workspaceRoot}`)
    }

    return workspaceRoot
}

export const resolveWorkspacePath = async (
    workspaceRoot: string,
    requestedPath: string
): Promise<WorkspacePathPermissionDecision> => {
    // Validate the lexical path first and its real target below. Together the checks block
    // traversal, symlink escapes, and safe-looking aliases to sensitive targets.
    const absolutePath = resolve(workspaceRoot, requestedPath)

    if (!isPathInsideWorkspace(workspaceRoot, absolutePath)) {
        return {
            decision: 'deny',
            reason: 'outside_workspace',
        }
    }

    const requestedRelativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath)

    if (isSensitivePath(requestedRelativePath)) {
        return {
            decision: 'deny',
            reason: 'sensitive_path',
        }
    }

    const canonicalPath = await realpath(absolutePath)

    if (!isPathInsideWorkspace(workspaceRoot, canonicalPath)) {
        return {
            decision: 'deny',
            reason: 'outside_workspace',
        }
    }

    const canonicalRelativePath = toWorkspaceRelativePath(workspaceRoot, canonicalPath)

    if (isSensitivePath(canonicalRelativePath)) {
        return {
            decision: 'deny',
            reason: 'sensitive_path',
        }
    }

    return {
        decision: 'allow',
        absolutePath: canonicalPath,
        relativePath: canonicalRelativePath,
    }
}
