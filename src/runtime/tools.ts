import { z } from 'zod'

import { LIST_FILES_MAX_LIMIT, SEARCH_CODE_MAX_LIMIT } from './filesystem-limits.ts'

export type ToolName = 'list_files' | 'search_code' | 'read_file'

export const listFilesArgumentsSchema = z
    .object({
        path: z.string().min(1),
        glob: z.string().min(1).optional(),
        limit: z.number().int().positive().max(LIST_FILES_MAX_LIMIT).optional(),
    })
    .strict()

export type ListFilesArguments = z.infer<typeof listFilesArgumentsSchema>

export const searchCodeArgumentsSchema = z
    .object({
        query: z.string().min(1),
        path: z.string().min(1).optional(),
        glob: z.string().min(1).optional(),
        limit: z.number().int().positive().max(SEARCH_CODE_MAX_LIMIT).optional(),
    })
    .strict()

export type SearchCodeArguments = z.infer<typeof searchCodeArgumentsSchema>

export const readFileArgumentsSchema = z
    .object({
        path: z.string().min(1),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
    })
    .strict()
    .refine(
        ({ startLine, endLine }) =>
            startLine === undefined || endLine === undefined || startLine <= endLine,
        {
            message: 'startLine must be less than or equal to endLine',
            path: ['endLine'],
        }
    )

export type ReadFileArguments = z.infer<typeof readFileArgumentsSchema>

// Model-provided arguments remain untrusted until the matching strict schema validates them.
export type ToolCall = {
    id: string
    name: string
    arguments: unknown
}

export type ToolResultStatus =
    | 'success'
    | 'invalid_arguments'
    | 'unknown_tool'
    | 'denied'
    | 'timeout'
    | 'execution_error'
    | 'aborted'

export type ToolResultMetadata = {
    truncated: boolean
    truncation: ToolResultTruncation | null
}

export type ToolResultTruncation = {
    reason: 'byte_limit' | 'line_limit' | 'result_limit'
    limit: number
    observed: number
}

export type ToolError = {
    code: string
    message: string
}

export type ToolResult =
    | {
          status: Extract<ToolResultStatus, 'success'>
          callId: string
          content: string
          metadata: ToolResultMetadata
      }
    | {
          status: Exclude<ToolResultStatus, 'success'>
          callId: string
          content: string
          metadata: ToolResultMetadata
          error: ToolError
      }
