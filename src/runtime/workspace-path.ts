import { isAbsolute, relative, sep } from 'node:path'

export const isPathInsideWorkspace = (workspaceRoot: string, absolutePath: string): boolean => {
    const relativePath = relative(workspaceRoot, absolutePath)

    return (
        relativePath === '' ||
        (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
    )
}

export const toWorkspaceRelativePath = (workspaceRoot: string, absolutePath: string): string => {
    const relativePath = relative(workspaceRoot, absolutePath)

    return relativePath === '' ? '.' : relativePath.split(sep).join('/')
}
