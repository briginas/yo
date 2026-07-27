import { z, type ZodType } from 'zod'

import type { Credential, CredentialStore } from '../auth/credential.ts'
import { resolveOpenAICodexCredential } from '../auth/openai-codex-login.ts'
import type { ModelRequest, ModelResponse, ModelTransport } from '../runtime/run.ts'
import {
    listFilesArgumentsSchema,
    readFileArgumentsSchema,
    searchCodeArgumentsSchema,
    type ToolName,
} from '../runtime/tools.ts'
import { proposePatchArgumentsSchema } from '../runtime/patch-contracts.ts'

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const DEFAULT_CODEX_MODEL = 'gpt-5.6-terra'

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
}

export type OpenAICodexRequestConversion = {
    instructions: string
    input: readonly OpenAICodexInputItem[]
    tools: readonly OpenAICodexFunctionTool[]
}

export type OpenAICodexResponsesRequestBody = OpenAICodexRequestConversion & {
    model: string
    reasoning: {
        effort: 'medium'
    }
    stream: true
    store: false
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
          summary?: readonly unknown[] | undefined
          content?: readonly unknown[] | undefined
      }

const openAICodexResponseOutputItemSchema: ZodType<OpenAICodexResponseOutputItem> =
    z.discriminatedUnion('type', [
        z.looseObject({
            type: z.literal('message'),
            content: z.array(
                z.discriminatedUnion('type', [
                    z.looseObject({
                        type: z.literal('output_text'),
                        text: z.string(),
                    }),
                    z.looseObject({
                        type: z.literal('refusal'),
                        refusal: z.string(),
                    }),
                ])
            ),
        }),
        z.looseObject({
            type: z.literal('function_call'),
            call_id: z.string().min(1),
            name: z.string().min(1),
            arguments: z.string(),
        }),
        z.looseObject({
            type: z.literal('reasoning'),
            summary: z.array(z.unknown()).optional(),
            content: z.array(z.unknown()).optional(),
        }),
    ])

const openAICodexSseEventEnvelopeSchema = z.looseObject({
    type: z.string(),
})

const openAICodexCompletedEventSchema = z.object({
    type: z.literal('response.completed'),
    response: z.object({
        model: z.string().min(1),
        output: z.array(openAICodexResponseOutputItemSchema),
    }),
})

const openAICodexOutputTextDeltaEventSchema = z.object({
    type: z.literal('response.output_text.delta'),
    output_index: z.number().int().nonnegative(),
    delta: z.string(),
})

const openAICodexOutputItemDoneEventSchema = z.object({
    type: z.literal('response.output_item.done'),
    output_index: z.number().int().nonnegative(),
    item: openAICodexResponseOutputItemSchema,
})

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
    propose_patch: {
        description:
            'Propose exact replacements in one existing file inside the approved workspace. The user must review the complete diff and explicitly approve before any write occurs.',
        schema: proposePatchArgumentsSchema,
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

export const buildOpenAICodexResponsesRequestBody = (
    request: ModelRequest
): OpenAICodexResponsesRequestBody => ({
    model: request.model ?? DEFAULT_CODEX_MODEL,
    reasoning: {
        effort: 'medium',
    },
    stream: true,
    store: false,
    ...convertModelRequestToOpenAICodex(request),
})

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

    try {
        return await sendRequest(CODEX_RESPONSES_URL, {
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
    } catch {
        throw new Error('OpenAI Codex network request failed.')
    }
}

export type OpenAICodexFinalAnswerTextSink = (delta: string) => void

type OpenAICodexSseState = {
    textDeltasByOutputIndex: Map<number, string[]>
    outputItemsByIndex: Map<number, OpenAICodexResponseOutputItem>
    hasAmbiguousOutputIdentity: boolean
}

type ParsedSseRecord =
    | {
          type: 'event'
          event: unknown
      }
    | {
          type: 'done'
      }
    | {
          type: 'ignored'
      }

const parseSseRecord = (record: string): ParsedSseRecord => {
    const data = record
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
        .trim()

    if (data.length === 0) {
        return { type: 'ignored' }
    }

    if (data === '[DONE]') {
        return { type: 'done' }
    }

    try {
        return {
            type: 'event',
            event: JSON.parse(data),
        }
    } catch {
        throw new Error('OpenAI Codex SSE protocol error.')
    }
}

const findSseRecordBoundary = (
    buffer: string
): {
    index: number
    length: number
} | null => {
    const match = /\r?\n\r?\n/.exec(buffer)

    return match === null
        ? null
        : {
              index: match.index,
              length: match[0].length,
          }
}

const processOpenAICodexSseEvent = (
    event: unknown,
    state: OpenAICodexSseState,
    onFinalAnswerTextDelta: OpenAICodexFinalAnswerTextSink | undefined
): ModelResponse | null => {
    const envelope = openAICodexSseEventEnvelopeSchema.safeParse(event)

    if (!envelope.success) {
        return null
    }

    if (envelope.data.type === 'error' || envelope.data.type === 'response.failed') {
        throw new Error('OpenAI Codex streaming request failed.')
    }

    if (envelope.data.type === 'response.output_text.delta') {
        const parsed = openAICodexOutputTextDeltaEventSchema.safeParse(event)

        if (!parsed.success) {
            const identity = z
                .looseObject({
                    output_index: z.number().int().nonnegative(),
                })
                .safeParse(event)

            if (!identity.success) {
                state.hasAmbiguousOutputIdentity = true
                return null
            }

            throw new Error('OpenAI Codex SSE protocol error.')
        }

        if (parsed.data.delta.length === 0) {
            return null
        }

        const deltas = state.textDeltasByOutputIndex.get(parsed.data.output_index) ?? []

        deltas.push(parsed.data.delta)
        state.textDeltasByOutputIndex.set(parsed.data.output_index, deltas)
        return null
    }

    if (envelope.data.type === 'response.output_item.done') {
        const parsed = openAICodexOutputItemDoneEventSchema.safeParse(event)

        if (!parsed.success) {
            state.hasAmbiguousOutputIdentity = true
            return null
        }

        if (state.outputItemsByIndex.has(parsed.data.output_index)) {
            state.hasAmbiguousOutputIdentity = true
            return null
        }

        state.outputItemsByIndex.set(parsed.data.output_index, parsed.data.item)
        return null
    }

    if (envelope.data.type !== 'response.completed') {
        return null
    }

    const parsed = openAICodexCompletedEventSchema.safeParse(event)

    if (!parsed.success) {
        throw new Error('OpenAI Codex SSE protocol error.')
    }

    const completedOutput = parsed.data.response.output
    const orderedOutputItemEntries = [...state.outputItemsByIndex.entries()].sort(
        ([leftIndex], [rightIndex]) => leftIndex - rightIndex
    )
    const hasContiguousBufferedOutput = orderedOutputItemEntries.every(
        ([outputIndex], position) => outputIndex === position
    )
    const output =
        completedOutput.length > 0
            ? completedOutput
            : orderedOutputItemEntries.map(([, item]) => item)
    const response = convertOpenAICodexOutputToModelResponse(output, parsed.data.response.model)

    // Delay every callback until all indexed text can be reconciled; emitted text cannot be
    // retracted if a later provider event makes the output identity ambiguous.
    if (
        response.type === 'final_answer' &&
        !state.hasAmbiguousOutputIdentity &&
        (completedOutput.length > 0 || hasContiguousBufferedOutput) &&
        state.textDeltasByOutputIndex.size > 0
    ) {
        const confirmedDeltas: string[] = []
        const orderedDeltaEntries = [...state.textDeltasByOutputIndex.entries()].sort(
            ([leftIndex], [rightIndex]) => leftIndex - rightIndex
        )
        let canRelease = true

        for (const [outputIndex, deltas] of orderedDeltaEntries) {
            const completedItem = state.outputItemsByIndex.get(outputIndex)
            const authoritativeItem = completedOutput[outputIndex] ?? completedItem

            if (
                completedItem === undefined ||
                authoritativeItem === undefined ||
                JSON.stringify(completedItem) !== JSON.stringify(authoritativeItem)
            ) {
                canRelease = false
                break
            }

            if (completedItem.type !== 'message') {
                continue
            }

            const outputText = completedItem.content
                .filter(
                    (content): content is Extract<typeof content, { type: 'output_text' }> =>
                        content.type === 'output_text'
                )
                .map((content) => content.text)
                .join('')

            if (deltas.join('') !== outputText) {
                canRelease = false
                break
            }

            confirmedDeltas.push(...deltas)
        }

        if (canRelease && confirmedDeltas.join('') === response.content) {
            confirmedDeltas.forEach((delta) => onFinalAnswerTextDelta?.(delta))
        }
    }

    return response
}

export const parseOpenAICodexResponsesSse = async (
    response: Response,
    onFinalAnswerTextDelta?: OpenAICodexFinalAnswerTextSink
): Promise<ModelResponse> => {
    if (response.body === null) {
        throw new Error('OpenAI Codex SSE response body is missing.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const state: OpenAICodexSseState = {
        textDeltasByOutputIndex: new Map(),
        outputItemsByIndex: new Map(),
        hasAmbiguousOutputIdentity: false,
    }
    let buffer = ''

    const processRecord = (record: string): ModelResponse | null => {
        const parsedRecord = parseSseRecord(record)

        if (parsedRecord.type === 'done') {
            throw new Error('OpenAI Codex SSE stream ended before a completed response.')
        }

        if (parsedRecord.type !== 'event') {
            return null
        }

        return processOpenAICodexSseEvent(parsedRecord.event, state, onFinalAnswerTextDelta)
    }

    try {
        while (true) {
            const { done, value } = await reader.read()

            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })

            let boundary = findSseRecordBoundary(buffer)

            while (boundary !== null) {
                const record = buffer.slice(0, boundary.index)

                buffer = buffer.slice(boundary.index + boundary.length)

                const modelResponse = processRecord(record)

                if (modelResponse !== null) {
                    return modelResponse
                }

                boundary = findSseRecordBoundary(buffer)
            }

            if (done) {
                if (buffer.length > 0) {
                    const modelResponse = processRecord(buffer)

                    if (modelResponse !== null) {
                        return modelResponse
                    }
                }

                throw new Error('OpenAI Codex SSE stream ended before a completed response.')
            }
        }
    } finally {
        try {
            await reader.cancel()
        } catch {
            // The response may already be closed; cleanup must not replace the transport result.
        }

        try {
            reader.releaseLock()
        } catch {
            // A failed release is cleanup-only and must not replace the transport result.
        }
    }
}

export type OpenAICodexResponsesTransportOptions = {
    credentialStore: CredentialStore
    fetch?: typeof globalThis.fetch
    resolveCredential?: OpenAICodexCredentialResolver
}

const createOpenAICodexHttpError = (status: number): Error => {
    if (status === 401 || status === 403) {
        return new Error('OpenAI Codex authentication failed. Run yo login.')
    }

    if (status === 429) {
        return new Error('OpenAI Codex usage limit reached. Try again later.')
    }

    return new Error(`OpenAI Codex request failed with status ${status}.`)
}

export const createOpenAICodexResponsesTransport = ({
    credentialStore,
    fetch,
    resolveCredential,
}: OpenAICodexResponsesTransportOptions): ModelTransport => {
    return async (request, options) => {
        const response = await sendOpenAICodexResponsesRequest({
            body: buildOpenAICodexResponsesRequestBody(request),
            credentialStore,
            ...(fetch === undefined ? {} : { fetch }),
            ...(resolveCredential === undefined ? {} : { resolveCredential }),
        })

        if (!response.ok) {
            throw createOpenAICodexHttpError(response.status)
        }

        return parseOpenAICodexResponsesSse(response, options?.onFinalAnswerDelta)
    }
}
