import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

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
