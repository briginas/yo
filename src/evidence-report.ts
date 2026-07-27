import { relative, resolve, sep } from 'node:path'

import {
    readFileArgumentsSchema,
    type SessionState,
    type ToolCall,
    type ToolResult,
} from './runtime/index.ts'

const addUnique = (values: string[], seen: Set<string>, value: string): void => {
    if (seen.has(value)) {
        return
    }

    seen.add(value)
    values.push(value)
}

const normalizeWorkspacePath = (workspaceRoot: string, requestedPath: string): string => {
    const normalizedPath = relative(workspaceRoot, resolve(workspaceRoot, requestedPath))

    return normalizedPath === '' ? '.' : normalizedPath.split(sep).join('/')
}

const collectFiles = (
    session: SessionState,
    call: ToolCall,
    result: Extract<ToolResult, { status: 'success' }>
): string[] => {
    if (call.name === 'list_files') {
        return result.content.split('\n').filter((path) => path.length > 0 && !path.endsWith('/'))
    }

    if (call.name === 'search_code') {
        return result.content
            .split('\n')
            .map((match) => /^(.*):\d+:/.exec(match)?.[1])
            .filter((path): path is string => path !== undefined)
    }

    if (call.name === 'read_file') {
        const parsedArguments = readFileArgumentsSchema.safeParse(call.arguments)

        if (parsedArguments.success) {
            return [normalizeWorkspacePath(session.workspaceRoot, parsedArguments.data.path)]
        }
    }

    return []
}

export const formatEvidenceReport = (session: SessionState): string => {
    const callsById = new Map<string, ToolCall>()
    const tools: string[] = []
    const seenTools = new Set<string>()
    const files: string[] = []
    const seenFiles = new Set<string>()
    const patchPathsByCallId = new Map<string, string>()
    const patches: string[] = []
    const seenPatches = new Set<string>()

    for (const event of session.events) {
        if (event.type === 'tool_requested') {
            callsById.set(event.call.id, event.call)
            continue
        }

        if (event.type === 'patch_prepared') {
            patchPathsByCallId.set(event.callId, event.metadata.relativePath)
            continue
        }

        if (event.type === 'tool_authorized' && event.decision.decision === 'allow') {
            const call = callsById.get(event.callId)

            if (call !== undefined) {
                addUnique(tools, seenTools, call.name)
            }

            continue
        }

        if (event.type === 'tool_completed' && event.result.status === 'success') {
            const call = callsById.get(event.result.callId)

            if (call === undefined) {
                continue
            }

            for (const file of collectFiles(session, call, event.result)) {
                addUnique(files, seenFiles, file)
            }
        }

        if (event.type === 'tool_completed') {
            const relativePath = patchPathsByCallId.get(event.result.callId)

            if (relativePath !== undefined) {
                const outcome = event.result.status === 'success' ? 'applied' : event.result.status
                addUnique(patches, seenPatches, `${relativePath}: ${outcome}`)
            }
        }
    }

    return [
        'Evidence:',
        `Stop reason: ${session.stopReason ?? 'unknown'}`,
        `Tools: ${tools.length > 0 ? tools.join(', ') : '(none)'}`,
        'Files:',
        ...(files.length > 0 ? files.map((file) => `- ${file}`) : ['- (none)']),
        ...(patches.length === 0 ? [] : ['Patches:', ...patches.map((patch) => `- ${patch}`)]),
    ].join('\n')
}

export const formatSessionReport = (session: SessionState): string =>
    [session.finalAnswer ?? 'No final answer.', '', formatEvidenceReport(session)].join('\n')
