import { z, type ZodType } from 'zod'

import type { Credential, CredentialStore } from '../auth/credential.ts'
import { resolveOpenAICodexCredential } from '../auth/openai-codex-login.ts'
import type { ModelRequest, ModelResponse } from '../runtime/run.ts'
import {
    listFilesArgumentsSchema,
    readFileArgumentsSchema,
    searchCodeArgumentsSchema,
    type ToolName,
} from '../runtime/tools.ts'

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

type OpenAICodexInputText = {
    type: 'input_text'
    text: string
}

type OpenAICodexOutputText = {
    type: 'output_text'
    text: string
    annotations: readonly unknown[]
}

export type OpenAICodexInputItem =
    | {
          role: 'user'
          content: readonly OpenAICodexInputText[]
      }
    | {
          type: 'message'
          id: string
          role: 'assistant'
          content: readonly OpenAICodexOutputText[]
          status: 'completed'
      }
    | {
          type: 'function_call'
          call_id: string
          name: string
          arguments: string
      }
    | {
          type: 'function_call_output'
          call_id: string
          output: string
      }

export type OpenAICodexFunctionTool = {
    type: 'function'
    name: ToolName
    description: string
    parameters: Readonly<Record<string, unknown>>
    strict: null
}

export type OpenAICodexRequestConversion = {
    instructions: string
    input: readonly OpenAICodexInputItem[]
    tools: readonly OpenAICodexFunctionTool[]
}

export type OpenAICodexResponseOutputItem =
    | {
          type: 'message'
          content: readonly (
              | {
                    type: 'output_text'
                    text: string
                }
              | {
                    type: 'refusal'
                    refusal: string
                }
          )[]
      }
    | {
          type: 'function_call'
          call_id: string
          name: string
          arguments: string
      }
    | {
          type: 'reasoning'
          summary?: readonly unknown[]
          content?: readonly unknown[]
      }

type ModelToolDefinition = {
    description: string
    schema: ZodType
}

const MODEL_TOOL_DEFINITIONS = {
    list_files: {
        description:
            'List files and directories inside the approved workspace, optionally filtered by a glob.',
        schema: listFilesArgumentsSchema,
    },
    search_code: {
        description:
            'Search for case-sensitive literal text inside files in the approved workspace.',
        schema: searchCodeArgumentsSchema,
    },
    read_file: {
        description:
            'Read a UTF-8 text file or inclusive line range inside the approved workspace.',
        schema: readFileArgumentsSchema,
    },
} as const satisfies Record<ToolName, ModelToolDefinition>

const convertToolParameters = (schema: ZodType): Readonly<Record<string, unknown>> => {
    // The provider accepts the schema object itself, without its document-level dialect marker.
    const { $schema: _schemaDialect, ...parameters } = z.toJSONSchema(schema, { io: 'input' })

    return parameters
}

const convertVisibleTools = (
    visibleTools: readonly ToolName[]
): readonly OpenAICodexFunctionTool[] =>
    visibleTools.map((name) => {
        const definition = MODEL_TOOL_DEFINITIONS[name]

        return {
            type: 'function',
            name,
            description: definition.description,
            parameters: convertToolParameters(definition.schema),
            strict: null,
        }
    })

const serializeToolCallArguments = (arguments_: unknown): string =>
    JSON.stringify(arguments_) ?? 'null'

export const convertModelRequestToOpenAICodex = ({
    messages,
    visibleTools,
}: ModelRequest): OpenAICodexRequestConversion => {
    const instructions = messages
        .flatMap((message) => (message.role === 'system' ? [message.content] : []))
        .join('\n\n')
    const input: OpenAICodexInputItem[] = []

    messages.forEach((message, messageIndex) => {
        if (message.role === 'system') {
            return
        }

        if (message.role === 'user') {
            input.push({
                role: 'user',
                content: [{ type: 'input_text', text: message.content }],
            })
            return
        }

        if (message.role === 'assistant') {
            if (message.content.length > 0) {
                input.push({
                    type: 'message',
                    id: `msg_yo_${messageIndex}`,
                    role: 'assistant',
                    content: [
                        {
                            type: 'output_text',
                            text: message.content,
                            annotations: [],
                        },
                    ],
                    status: 'completed',
                })
            }

            for (const call of message.toolCalls) {
                input.push({
                    type: 'function_call',
                    call_id: call.id,
                    name: call.name,
                    arguments: serializeToolCallArguments(call.arguments),
                })
            }
            return
        }

        if (message.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.result.callId,
                output: JSON.stringify(message.result),
            })
        }
    })

    return {
        instructions,
        input,
        tools: convertVisibleTools(visibleTools),
    }
}

const parseToolCallArguments = (arguments_: string): unknown => {
    try {
        return JSON.parse(arguments_)
    } catch {
        return arguments_
    }
}

export const convertOpenAICodexOutputToModelResponse = (
    output: readonly OpenAICodexResponseOutputItem[],
    model: string | null
): ModelResponse => {
    const text = output
        .flatMap((item) =>
            item.type === 'message'
                ? item.content
                      .filter(
                          (content): content is Extract<typeof content, { type: 'output_text' }> =>
                              content.type === 'output_text'
                      )
                      .map((content) => content.text)
                : []
        )
        .join('')
    const toolCalls = output.flatMap((item) =>
        item.type === 'function_call'
            ? [
                  {
                      id: item.call_id,
                      name: item.name,
                      arguments: parseToolCallArguments(item.arguments),
                  },
              ]
            : []
    )
    const [firstToolCall, ...remainingToolCalls] = toolCalls

    if (firstToolCall !== undefined) {
        return {
            type: 'tool_calls',
            model,
            ...(text.length > 0 ? { content: text } : {}),
            toolCalls: [firstToolCall, ...remainingToolCalls],
        }
    }

    return {
        type: 'final_answer',
        model,
        content: text,
    }
}

export type OpenAICodexCredentialResolver = (options: {
    credentialStore: CredentialStore
}) => Promise<Credential | undefined>

export type OpenAICodexResponsesRequestOptions = {
    body: Readonly<Record<string, unknown>>
    credentialStore: CredentialStore
    fetch?: typeof globalThis.fetch
    resolveCredential?: OpenAICodexCredentialResolver
}

export const sendOpenAICodexResponsesRequest = async ({
    body,
    credentialStore,
    fetch: sendRequest = globalThis.fetch,
    resolveCredential = resolveOpenAICodexCredential,
}: OpenAICodexResponsesRequestOptions): Promise<Response> => {
    const credential = await resolveCredential({ credentialStore })

    if (credential === undefined) {
        throw new Error('OpenAI Codex authentication is required. Run yo login.')
    }

    return sendRequest(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            'chatgpt-account-id': credential.accountId,
            originator: 'yo',
            'OpenAI-Beta': 'responses=experimental',
            accept: 'text/event-stream',
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    })
}
