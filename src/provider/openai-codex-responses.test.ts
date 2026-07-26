import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Credential, CredentialStore } from '../auth/credential.ts'
import type { ModelRequest } from '../runtime/run.ts'
import {
    buildOpenAICodexResponsesRequestBody,
    convertModelRequestToOpenAICodex,
    convertOpenAICodexOutputToModelResponse,
    createOpenAICodexResponsesTransport,
    parseOpenAICodexResponsesSse,
    sendOpenAICodexResponsesRequest,
} from './openai-codex-responses.ts'

const unusedCredentialStore: CredentialStore = {
    read: async () => {
        throw new Error('read must not run')
    },
    modify: async () => {
        throw new Error('modify must not run')
    },
    delete: async () => {
        throw new Error('delete must not run')
    },
}

const serializeSseEvent = (event: unknown, lineEnding = '\n'): string =>
    `data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`

const createChunkedSseResponse = ({
    payload,
    chunkSize,
    close = true,
    onCancel,
}: {
    payload: string
    chunkSize: number
    close?: boolean
    onCancel?: () => void
}): Response => {
    const bytes = new TextEncoder().encode(payload)

    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                    controller.enqueue(bytes.slice(offset, offset + chunkSize))
                }

                if (close) {
                    controller.close()
                }
            },
            cancel() {
                onCancel?.()
            },
        }),
        {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        }
    )
}

describe('convertModelRequestToOpenAICodex', () => {
    test('converts the provider-neutral transcript without losing tool observations', () => {
        const request = {
            model: 'test-model',
            messages: [
                { role: 'system', content: 'Inspect only the workspace.' },
                { role: 'system', content: 'Use read-only tools.' },
                { role: 'user', content: 'Find the provider.' },
                {
                    role: 'assistant',
                    content: 'I will inspect the source.',
                    toolCalls: [
                        {
                            id: 'call-search',
                            name: 'search_code',
                            arguments: { query: 'provider', path: 'src' },
                        },
                        {
                            id: 'call-read',
                            name: 'read_file',
                            arguments: { path: 'src/provider.ts', startLine: 1, endLine: 20 },
                        },
                    ],
                },
                {
                    role: 'tool',
                    result: {
                        status: 'success',
                        callId: 'call-search',
                        content: 'src/provider.ts:4:provider',
                        metadata: {
                            truncated: true,
                            truncation: {
                                reason: 'result_limit',
                                limit: 1,
                                observed: 2,
                            },
                        },
                    },
                },
                {
                    role: 'tool',
                    result: {
                        status: 'denied',
                        callId: 'call-read',
                        content: 'Tool access denied: sensitive_path',
                        metadata: {
                            truncated: false,
                            truncation: null,
                        },
                        error: {
                            code: 'sensitive_path',
                            message: 'Tool access denied: sensitive_path',
                        },
                    },
                },
            ],
            visibleTools: ['list_files', 'search_code', 'read_file'],
        } as const satisfies ModelRequest

        const converted = convertModelRequestToOpenAICodex(request)

        assert.equal(converted.instructions, 'Inspect only the workspace.\n\nUse read-only tools.')
        assert.deepEqual(converted.input, [
            {
                role: 'user',
                content: [{ type: 'input_text', text: 'Find the provider.' }],
            },
            {
                type: 'message',
                id: 'msg_yo_3',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text: 'I will inspect the source.',
                        annotations: [],
                    },
                ],
                status: 'completed',
            },
            {
                type: 'function_call',
                call_id: 'call-search',
                name: 'search_code',
                arguments: JSON.stringify({ query: 'provider', path: 'src' }),
            },
            {
                type: 'function_call',
                call_id: 'call-read',
                name: 'read_file',
                arguments: JSON.stringify({
                    path: 'src/provider.ts',
                    startLine: 1,
                    endLine: 20,
                }),
            },
            {
                type: 'function_call_output',
                call_id: 'call-search',
                output: JSON.stringify(request.messages[4].result),
            },
            {
                type: 'function_call_output',
                call_id: 'call-read',
                output: JSON.stringify(request.messages[5].result),
            },
        ])
    })

    test('exposes only the requested closed read-only tool definitions', () => {
        const converted = convertModelRequestToOpenAICodex({
            model: null,
            messages: [],
            visibleTools: ['search_code', 'list_files', 'read_file'],
        })

        assert.deepEqual(
            converted.tools.map((tool) => tool.name),
            ['search_code', 'list_files', 'read_file']
        )
        assert.deepEqual(
            converted.tools.map((tool) => tool.type),
            ['function', 'function', 'function']
        )
        assert.deepEqual(
            converted.tools.map((tool) => 'strict' in tool),
            [false, false, false]
        )

        const definitions = Object.fromEntries(converted.tools.map((tool) => [tool.name, tool]))
        const listFilesParameters = definitions.list_files?.parameters
        const searchCodeParameters = definitions.search_code?.parameters
        const readFileParameters = definitions.read_file?.parameters

        assert.equal('$schema' in (listFilesParameters ?? {}), false)
        assert.deepEqual(listFilesParameters?.required, ['path'])
        assert.equal(listFilesParameters?.additionalProperties, false)
        assert.equal(
            (
                (
                    listFilesParameters?.properties as
                        Record<string, Record<string, unknown>> | undefined
                )?.limit ?? {}
            ).maximum,
            500
        )

        assert.equal('$schema' in (searchCodeParameters ?? {}), false)
        assert.deepEqual(searchCodeParameters?.required, ['query'])
        assert.equal(searchCodeParameters?.additionalProperties, false)
        assert.equal(
            (
                (
                    searchCodeParameters?.properties as
                        Record<string, Record<string, unknown>> | undefined
                )?.limit ?? {}
            ).maximum,
            100
        )

        assert.equal('$schema' in (readFileParameters ?? {}), false)
        assert.deepEqual(readFileParameters?.required, ['path'])
        assert.equal(readFileParameters?.additionalProperties, false)

        const serializedTools = JSON.stringify(converted.tools)

        for (const forbiddenName of [
            'write_file',
            'apply_patch',
            'shell',
            'process',
            'network',
            'credential',
        ]) {
            assert.equal(serializedTools.includes(forbiddenName), false)
        }
    })

    test('omits empty assistant text while retaining its tool calls', () => {
        const converted = convertModelRequestToOpenAICodex({
            model: null,
            messages: [
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        {
                            id: 'call-list',
                            name: 'list_files',
                            arguments: undefined,
                        },
                    ],
                },
            ],
            visibleTools: [],
        })

        assert.deepEqual(converted.input, [
            {
                type: 'function_call',
                call_id: 'call-list',
                name: 'list_files',
                arguments: 'null',
            },
        ])
    })
})

describe('buildOpenAICodexResponsesRequestBody', () => {
    test('uses the default model and medium reasoning while preserving the conversion', () => {
        const request = {
            model: null,
            messages: [
                { role: 'system', content: 'Inspect only the workspace.' },
                { role: 'user', content: 'Find the provider.' },
            ],
            visibleTools: ['search_code'],
        } as const satisfies ModelRequest

        const body = buildOpenAICodexResponsesRequestBody(request)
        const { model, reasoning, stream, store, ...conversion } = body

        assert.equal(model, 'gpt-5.6-terra')
        assert.deepEqual(reasoning, { effort: 'medium' })
        assert.equal(stream, true)
        assert.equal(store, false)
        assert.deepEqual(conversion, convertModelRequestToOpenAICodex(request))
    })

    test('keeps an explicit model override with medium reasoning', () => {
        const body = buildOpenAICodexResponsesRequestBody({
            model: 'chosen-model',
            messages: [],
            visibleTools: [],
        })

        assert.equal(body.model, 'chosen-model')
        assert.deepEqual(body.reasoning, { effort: 'medium' })
        assert.equal(body.stream, true)
        assert.equal(body.store, false)
    })
})

describe('convertOpenAICodexOutputToModelResponse', () => {
    test('combines final output text while excluding refusals and reasoning', () => {
        const response = convertOpenAICodexOutputToModelResponse(
            [
                {
                    type: 'reasoning',
                    summary: [{ text: 'private reasoning summary' }],
                    content: [{ text: 'private reasoning content' }],
                },
                {
                    type: 'message',
                    content: [
                        { type: 'output_text', text: 'Grounded ' },
                        { type: 'refusal', refusal: 'hidden refusal' },
                        { type: 'output_text', text: 'answer.' },
                    ],
                },
            ],
            'test-model'
        )

        assert.deepEqual(response, {
            type: 'final_answer',
            model: 'test-model',
            content: 'Grounded answer.',
        })
        assert.equal(JSON.stringify(response).includes('private reasoning'), false)
        assert.equal(JSON.stringify(response).includes('hidden refusal'), false)
    })

    test('normalizes ordered tool calls and keeps assistant preamble text', () => {
        const response = convertOpenAICodexOutputToModelResponse(
            [
                {
                    type: 'message',
                    content: [{ type: 'output_text', text: 'I need two files.' }],
                },
                {
                    type: 'function_call',
                    call_id: 'call-list',
                    name: 'list_files',
                    arguments: '{"path":"src"}',
                },
                {
                    type: 'function_call',
                    call_id: 'call-read',
                    name: 'read_file',
                    arguments: '{"path":"src/index.ts","startLine":1}',
                },
            ],
            'test-model'
        )

        assert.deepEqual(response, {
            type: 'tool_calls',
            model: 'test-model',
            content: 'I need two files.',
            toolCalls: [
                {
                    id: 'call-list',
                    name: 'list_files',
                    arguments: { path: 'src' },
                },
                {
                    id: 'call-read',
                    name: 'read_file',
                    arguments: { path: 'src/index.ts', startLine: 1 },
                },
            ],
        })
    })

    test('keeps malformed function arguments untrusted for dispatcher validation', () => {
        const response = convertOpenAICodexOutputToModelResponse(
            [
                {
                    type: 'function_call',
                    call_id: 'call-invalid',
                    name: 'read_file',
                    arguments: '{"path":',
                },
            ],
            null
        )

        assert.deepEqual(response, {
            type: 'tool_calls',
            model: null,
            toolCalls: [
                {
                    id: 'call-invalid',
                    name: 'read_file',
                    arguments: '{"path":',
                },
            ],
        })
    })
})

describe('parseOpenAICodexResponsesSse', () => {
    test('parses chunked CRLF events and releases only completed final-answer text', async () => {
        const privateReasoning = 'private-reasoning-sentinel'
        const hiddenRefusal = 'hidden-refusal-sentinel'
        const deltas: string[] = []
        let cancelled = false
        const payload = [
            ': keep-alive\r\n\r\n',
            'data: {"type":"response.created",\r\n',
            'data: "sequence_number":0}\r\n\r\n',
            serializeSseEvent(
                {
                    type: 'response.reasoning_summary_text.delta',
                    delta: privateReasoning,
                },
                '\r\n'
            ),
            serializeSseEvent(
                {
                    type: 'response.output_text.delta',
                    output_index: 1,
                    delta: 'Grounded ',
                },
                '\r\n'
            ),
            serializeSseEvent(
                {
                    type: 'response.output_text.delta',
                    output_index: 1,
                    delta: '✅ answer.',
                },
                '\r\n'
            ),
            serializeSseEvent(
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                        type: 'reasoning',
                        summary: [{ text: privateReasoning }],
                    },
                },
                '\r\n'
            ),
            serializeSseEvent(
                {
                    type: 'response.output_item.done',
                    output_index: 1,
                    item: {
                        type: 'message',
                        content: [
                            { type: 'output_text', text: 'Grounded ' },
                            { type: 'refusal', refusal: hiddenRefusal },
                            { type: 'output_text', text: '✅ answer.' },
                        ],
                    },
                },
                '\r\n'
            ),
            serializeSseEvent(
                {
                    type: 'response.completed',
                    response: {
                        model: 'test-model',
                        output: [
                            {
                                type: 'reasoning',
                                summary: [{ text: privateReasoning }],
                            },
                            {
                                type: 'message',
                                content: [
                                    { type: 'output_text', text: 'Grounded ' },
                                    { type: 'refusal', refusal: hiddenRefusal },
                                    { type: 'output_text', text: '✅ answer.' },
                                ],
                            },
                        ],
                    },
                },
                '\r\n'
            ),
            'data: [DONE]\r\n\r\n',
        ].join('')
        const response = await parseOpenAICodexResponsesSse(
            createChunkedSseResponse({
                payload,
                chunkSize: 1,
                close: false,
                onCancel: () => {
                    cancelled = true
                },
            }),
            (delta) => deltas.push(delta)
        )

        assert.deepEqual(response, {
            type: 'final_answer',
            model: 'test-model',
            content: 'Grounded ✅ answer.',
        })
        assert.deepEqual(deltas, ['Grounded ', '✅ answer.'])
        assert.equal(cancelled, true)

        const visibleData = JSON.stringify({ response, deltas })

        assert.equal(visibleData.includes(privateReasoning), false)
        assert.equal(visibleData.includes(hiddenRefusal), false)
    })

    test('returns ordered tool calls without releasing assistant preamble text', async () => {
        const deltas: string[] = []
        const payload = [
            serializeSseEvent({
                type: 'response.output_text.delta',
                output_index: 0,
                delta: 'I need two files.',
            }),
            serializeSseEvent({
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    type: 'message',
                    content: [{ type: 'output_text', text: 'I need two files.' }],
                },
            }),
            serializeSseEvent({
                type: 'response.function_call_arguments.delta',
                delta: '{"private":"tool-argument-sentinel"}',
            }),
            serializeSseEvent({
                type: 'response.completed',
                response: {
                    model: 'test-model',
                    output: [
                        {
                            type: 'message',
                            content: [
                                {
                                    type: 'output_text',
                                    text: 'I need two files.',
                                },
                            ],
                        },
                        {
                            type: 'function_call',
                            call_id: 'call-list',
                            name: 'list_files',
                            arguments: '{"path":"src"}',
                        },
                        {
                            type: 'function_call',
                            call_id: 'call-read',
                            name: 'read_file',
                            arguments: '{"path":"src/index.ts","startLine":1}',
                        },
                    ],
                },
            }),
        ].join('')

        const response = await parseOpenAICodexResponsesSse(
            createChunkedSseResponse({ payload, chunkSize: 7 }),
            (delta) => deltas.push(delta)
        )

        assert.deepEqual(response, {
            type: 'tool_calls',
            model: 'test-model',
            content: 'I need two files.',
            toolCalls: [
                {
                    id: 'call-list',
                    name: 'list_files',
                    arguments: { path: 'src' },
                },
                {
                    id: 'call-read',
                    name: 'read_file',
                    arguments: { path: 'src/index.ts', startLine: 1 },
                },
            ],
        })
        assert.deepEqual(deltas, [])
    })

    test('uses completed output items when the terminal response output is empty', async (t) => {
        await t.test('tool call', async () => {
            const payload = [
                serializeSseEvent({
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                        type: 'reasoning',
                        summary: [],
                    },
                }),
                serializeSseEvent({
                    type: 'response.output_item.done',
                    output_index: 1,
                    item: {
                        type: 'function_call',
                        call_id: 'call-read',
                        name: 'read_file',
                        arguments: '{"path":"src/cli.ts"}',
                    },
                }),
                serializeSseEvent({
                    type: 'response.completed',
                    response: {
                        model: 'test-model',
                        output: [],
                    },
                }),
            ].join('')

            const response = await parseOpenAICodexResponsesSse(
                createChunkedSseResponse({ payload, chunkSize: 9 })
            )

            assert.deepEqual(response, {
                type: 'tool_calls',
                model: 'test-model',
                toolCalls: [
                    {
                        id: 'call-read',
                        name: 'read_file',
                        arguments: { path: 'src/cli.ts' },
                    },
                ],
            })
        })

        await t.test('final answer', async () => {
            const deltas: string[] = []
            const payload = [
                serializeSseEvent({
                    type: 'response.output_text.delta',
                    output_index: 0,
                    delta: 'Grounded answer.',
                }),
                serializeSseEvent({
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'Grounded answer.' }],
                    },
                }),
                serializeSseEvent({
                    type: 'response.completed',
                    response: {
                        model: 'test-model',
                        output: [],
                    },
                }),
            ].join('')

            const response = await parseOpenAICodexResponsesSse(
                createChunkedSseResponse({ payload, chunkSize: 8 }),
                (delta) => deltas.push(delta)
            )

            assert.deepEqual(response, {
                type: 'final_answer',
                model: 'test-model',
                content: 'Grounded answer.',
            })
            assert.deepEqual(deltas, ['Grounded answer.'])
        })
    })

    test('reconciles indexed answer deltas before releasing them', async (t) => {
        await t.test('orders interleaved confirmed message items by output index', async () => {
            const deltas: string[] = []
            const payload = [
                serializeSseEvent({
                    type: 'response.output_text.delta',
                    output_index: 2,
                    delta: 'answer.',
                }),
                serializeSseEvent({
                    type: 'response.output_text.delta',
                    output_index: 0,
                    delta: 'Grounded ',
                }),
                serializeSseEvent({
                    type: 'response.output_item.done',
                    output_index: 1,
                    item: {
                        type: 'reasoning',
                        summary: [{ text: 'private-reasoning' }],
                    },
                }),
                serializeSseEvent({
                    type: 'response.output_item.done',
                    output_index: 2,
                    item: {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'answer.' }],
                    },
                }),
                serializeSseEvent({
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'Grounded ' }],
                    },
                }),
                serializeSseEvent({
                    type: 'response.completed',
                    response: {
                        model: 'test-model',
                        output: [
                            {
                                type: 'message',
                                content: [{ type: 'output_text', text: 'Grounded ' }],
                            },
                            {
                                type: 'reasoning',
                                summary: [{ text: 'private-reasoning' }],
                            },
                            {
                                type: 'message',
                                content: [{ type: 'output_text', text: 'answer.' }],
                            },
                        ],
                    },
                }),
            ].join('')

            const response = await parseOpenAICodexResponsesSse(
                createChunkedSseResponse({ payload, chunkSize: 3 }),
                (delta) => deltas.push(delta)
            )

            assert.deepEqual(response, {
                type: 'final_answer',
                model: 'test-model',
                content: 'Grounded answer.',
            })
            assert.deepEqual(deltas, ['Grounded ', 'answer.'])
        })

        const unresolvedCases = [
            {
                name: 'missing output-item completion',
                events: [
                    {
                        type: 'response.output_text.delta',
                        output_index: 0,
                        delta: 'Completed answer.',
                    },
                ],
                completedOutput: [
                    {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'Completed answer.' }],
                    },
                ],
                expectedContent: 'Completed answer.',
            },
            {
                name: 'missing delta output index',
                events: [
                    {
                        type: 'response.output_text.delta',
                        delta: 'Completed answer.',
                    },
                    {
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: {
                            type: 'message',
                            content: [{ type: 'output_text', text: 'Completed answer.' }],
                        },
                    },
                ],
                completedOutput: [
                    {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'Completed answer.' }],
                    },
                ],
                expectedContent: 'Completed answer.',
            },
            {
                name: 'duplicate output-item completion',
                events: [
                    {
                        type: 'response.output_text.delta',
                        output_index: 0,
                        delta: 'Completed answer.',
                    },
                    {
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: {
                            type: 'message',
                            content: [{ type: 'output_text', text: 'Completed answer.' }],
                        },
                    },
                    {
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: {
                            type: 'message',
                            content: [{ type: 'output_text', text: 'Completed answer.' }],
                        },
                    },
                ],
                completedOutput: [
                    {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'Completed answer.' }],
                    },
                ],
                expectedContent: 'Completed answer.',
            },
            {
                name: 'misordered completed output identity',
                events: [
                    {
                        type: 'response.output_text.delta',
                        output_index: 0,
                        delta: 'Completed answer.',
                    },
                    {
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: {
                            type: 'message',
                            content: [{ type: 'output_text', text: 'Completed answer.' }],
                        },
                    },
                ],
                completedOutput: [
                    {
                        type: 'reasoning',
                        summary: [],
                    },
                    {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'Completed answer.' }],
                    },
                ],
                expectedContent: 'Completed answer.',
            },
            {
                name: 'completed-response mismatch',
                events: [
                    {
                        type: 'response.output_text.delta',
                        output_index: 0,
                        delta: 'Streamed answer.',
                    },
                    {
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: {
                            type: 'message',
                            content: [{ type: 'output_text', text: 'Streamed answer.' }],
                        },
                    },
                ],
                completedOutput: [
                    {
                        type: 'message',
                        content: [{ type: 'output_text', text: 'Completed answer.' }],
                    },
                ],
                expectedContent: 'Completed answer.',
            },
        ] as const

        for (const testCase of unresolvedCases) {
            await t.test(`${testCase.name} falls back without releasing text`, async () => {
                const deltas: string[] = []
                const payload = [
                    ...testCase.events.map((event) => serializeSseEvent(event)),
                    serializeSseEvent({
                        type: 'response.completed',
                        response: {
                            model: 'test-model',
                            output: testCase.completedOutput,
                        },
                    }),
                ].join('')

                const response = await parseOpenAICodexResponsesSse(
                    createChunkedSseResponse({ payload, chunkSize: 5 }),
                    (delta) => deltas.push(delta)
                )

                assert.deepEqual(response, {
                    type: 'final_answer',
                    model: 'test-model',
                    content: testCase.expectedContent,
                })
                assert.deepEqual(deltas, [])
            })
        }

        await t.test('ignores empty deltas', async () => {
            const deltas: string[] = []
            const payload = [
                serializeSseEvent({
                    type: 'response.output_text.delta',
                    output_index: 0,
                    delta: '',
                }),
                serializeSseEvent({
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: {
                        type: 'message',
                        content: [{ type: 'output_text', text: '' }],
                    },
                }),
                serializeSseEvent({
                    type: 'response.completed',
                    response: {
                        model: 'test-model',
                        output: [
                            {
                                type: 'message',
                                content: [{ type: 'output_text', text: '' }],
                            },
                        ],
                    },
                }),
            ].join('')

            const response = await parseOpenAICodexResponsesSse(
                createChunkedSseResponse({ payload, chunkSize: 4 }),
                (delta) => deltas.push(delta)
            )

            assert.deepEqual(response, {
                type: 'final_answer',
                model: 'test-model',
                content: '',
            })
            assert.deepEqual(deltas, [])
        })
    })

    test('sanitizes malformed events and streams that end before completion', async (t) => {
        await t.test('malformed JSON', async () => {
            const privatePayload = 'private-malformed-payload'

            await assert.rejects(
                parseOpenAICodexResponsesSse(
                    createChunkedSseResponse({
                        payload: `data: {"type":"${privatePayload}"\n\n`,
                        chunkSize: 3,
                    })
                ),
                (error: unknown) => {
                    assert.equal(
                        error instanceof Error ? error.message : undefined,
                        'OpenAI Codex SSE protocol error.'
                    )
                    assert.equal(String(error).includes(privatePayload), false)
                    return true
                }
            )
        })

        await t.test('missing terminal event', async () => {
            const privateReasoning = 'private-unfinished-reasoning'

            await assert.rejects(
                parseOpenAICodexResponsesSse(
                    createChunkedSseResponse({
                        payload: serializeSseEvent({
                            type: 'response.reasoning_summary_text.delta',
                            delta: privateReasoning,
                        }),
                        chunkSize: 5,
                    })
                ),
                (error: unknown) => {
                    assert.equal(
                        error instanceof Error ? error.message : undefined,
                        'OpenAI Codex SSE stream ended before a completed response.'
                    )
                    assert.equal(String(error).includes(privateReasoning), false)
                    return true
                }
            )
        })

        await t.test('malformed terminal payload', async () => {
            const privatePayload = 'private-terminal-payload'

            await assert.rejects(
                parseOpenAICodexResponsesSse(
                    createChunkedSseResponse({
                        payload: serializeSseEvent({
                            type: 'response.completed',
                            response: {
                                model: 'test-model',
                                output: privatePayload,
                            },
                        }),
                        chunkSize: 4,
                    })
                ),
                (error: unknown) => {
                    assert.equal(
                        error instanceof Error ? error.message : undefined,
                        'OpenAI Codex SSE protocol error.'
                    )
                    assert.equal(String(error).includes(privatePayload), false)
                    return true
                }
            )
        })

        await t.test('malformed final-answer delta', async () => {
            const privatePayload = 'private-delta-payload'

            await assert.rejects(
                parseOpenAICodexResponsesSse(
                    createChunkedSseResponse({
                        payload: serializeSseEvent({
                            type: 'response.output_text.delta',
                            output_index: 0,
                            delta: { text: privatePayload },
                        }),
                        chunkSize: 6,
                    })
                ),
                (error: unknown) => {
                    assert.equal(
                        error instanceof Error ? error.message : undefined,
                        'OpenAI Codex SSE protocol error.'
                    )
                    assert.equal(String(error).includes(privatePayload), false)
                    return true
                }
            )
        })
    })

    test('sanitizes terminal provider failure events', async (t) => {
        for (const type of ['error', 'response.failed'] as const) {
            await t.test(type, async () => {
                const privatePayload = `private-${type}-payload`
                const deltas: string[] = []

                await assert.rejects(
                    parseOpenAICodexResponsesSse(
                        createChunkedSseResponse({
                            payload: [
                                serializeSseEvent({
                                    type: 'response.output_text.delta',
                                    output_index: 0,
                                    delta: 'Unfinished answer.',
                                }),
                                serializeSseEvent({
                                    type: 'response.output_item.done',
                                    output_index: 0,
                                    item: {
                                        type: 'message',
                                        content: [
                                            {
                                                type: 'output_text',
                                                text: 'Unfinished answer.',
                                            },
                                        ],
                                    },
                                }),
                                serializeSseEvent({
                                    type,
                                    error: {
                                        message: privatePayload,
                                    },
                                }),
                            ].join(''),
                            chunkSize: 5,
                        }),
                        (delta) => deltas.push(delta)
                    ),
                    (error: unknown) => {
                        assert.equal(
                            error instanceof Error ? error.message : undefined,
                            'OpenAI Codex streaming request failed.'
                        )
                        assert.equal(String(error).includes(privatePayload), false)
                        return true
                    }
                )
                assert.deepEqual(deltas, [])
            })
        }
    })
})

describe('createOpenAICodexResponsesTransport', () => {
    test('builds, sends, and parses one provider-neutral model request', async () => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-access-token',
            refreshToken: 'private-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'account-id',
        } as const satisfies Credential
        let sentBody: unknown
        const transport = createOpenAICodexResponsesTransport({
            credentialStore: unusedCredentialStore,
            resolveCredential: async () => credential,
            fetch: async (_input, init) => {
                sentBody = JSON.parse(String(init?.body))

                return createChunkedSseResponse({
                    payload: serializeSseEvent({
                        type: 'response.completed',
                        response: {
                            model: 'chosen-model',
                            output: [
                                {
                                    type: 'message',
                                    content: [
                                        {
                                            type: 'output_text',
                                            text: 'Final answer.',
                                        },
                                    ],
                                },
                            ],
                        },
                    }),
                    chunkSize: 11,
                })
            },
        })

        const response = await transport({
            model: 'chosen-model',
            messages: [{ role: 'user', content: 'Inspect the workspace.' }],
            visibleTools: ['read_file'],
        })

        assert.deepEqual(response, {
            type: 'final_answer',
            model: 'chosen-model',
            content: 'Final answer.',
        })
        assert.equal(
            typeof sentBody === 'object' && sentBody !== null && 'stream' in sentBody
                ? sentBody.stream
                : undefined,
            true
        )
        assert.equal(JSON.stringify({ response, sentBody }).includes(credential.accessToken), false)
        assert.equal(
            JSON.stringify({ response, sentBody }).includes(credential.refreshToken),
            false
        )
    })

    test('delivers confirmed answer text through request-scoped options', async () => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-access-token',
            refreshToken: 'private-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'account-id',
        } as const satisfies Credential
        const deltas: string[] = []
        const answerItem = {
            type: 'message',
            content: [{ type: 'output_text', text: 'Final answer.' }],
        } as const
        const transport = createOpenAICodexResponsesTransport({
            credentialStore: unusedCredentialStore,
            resolveCredential: async () => credential,
            fetch: async () =>
                createChunkedSseResponse({
                    payload: [
                        serializeSseEvent({
                            type: 'response.output_text.delta',
                            output_index: 0,
                            delta: 'Final ',
                        }),
                        serializeSseEvent({
                            type: 'response.output_text.delta',
                            output_index: 0,
                            delta: 'answer.',
                        }),
                        serializeSseEvent({
                            type: 'response.output_item.done',
                            output_index: 0,
                            item: answerItem,
                        }),
                        serializeSseEvent({
                            type: 'response.completed',
                            response: {
                                model: 'test-model',
                                output: [answerItem],
                            },
                        }),
                    ].join(''),
                    chunkSize: 6,
                }),
        })

        const response = await transport(
            {
                model: 'test-model',
                messages: [{ role: 'user', content: 'Inspect the workspace.' }],
                visibleTools: ['read_file'],
            },
            {
                onFinalAnswerDelta: (delta) => deltas.push(delta),
            }
        )

        assert.deepEqual(response, {
            type: 'final_answer',
            model: 'test-model',
            content: 'Final answer.',
        })
        assert.deepEqual(deltas, ['Final ', 'answer.'])
    })

    test('normalizes single and multiple tool calls in provider order', async (t) => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-access-token',
            refreshToken: 'private-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'account-id',
        } as const satisfies Credential
        const cases = [
            {
                name: 'single tool call',
                output: [
                    {
                        type: 'function_call',
                        call_id: 'call-list',
                        name: 'list_files',
                        arguments: '{"path":"src"}',
                    },
                ],
                expectedToolCalls: [
                    {
                        id: 'call-list',
                        name: 'list_files',
                        arguments: { path: 'src' },
                    },
                ],
            },
            {
                name: 'multiple tool calls',
                output: [
                    {
                        type: 'function_call',
                        call_id: 'call-search',
                        name: 'search_code',
                        arguments: '{"query":"transport","path":"src"}',
                    },
                    {
                        type: 'function_call',
                        call_id: 'call-read',
                        name: 'read_file',
                        arguments: '{"path":"src/provider/openai-codex-responses.ts"}',
                    },
                ],
                expectedToolCalls: [
                    {
                        id: 'call-search',
                        name: 'search_code',
                        arguments: { query: 'transport', path: 'src' },
                    },
                    {
                        id: 'call-read',
                        name: 'read_file',
                        arguments: {
                            path: 'src/provider/openai-codex-responses.ts',
                        },
                    },
                ],
            },
        ] as const

        for (const testCase of cases) {
            await t.test(testCase.name, async () => {
                const transport = createOpenAICodexResponsesTransport({
                    credentialStore: unusedCredentialStore,
                    resolveCredential: async () => credential,
                    fetch: async () =>
                        createChunkedSseResponse({
                            payload: serializeSseEvent({
                                type: 'response.completed',
                                response: {
                                    model: 'test-model',
                                    output: testCase.output,
                                },
                            }),
                            chunkSize: 4,
                        }),
                })

                const response = await transport({
                    model: 'test-model',
                    messages: [{ role: 'user', content: 'Inspect the workspace.' }],
                    visibleTools: ['list_files', 'search_code', 'read_file'],
                })

                assert.deepEqual(response, {
                    type: 'tool_calls',
                    model: 'test-model',
                    toolCalls: testCase.expectedToolCalls,
                })
                assert.equal(JSON.stringify(response).includes(credential.accessToken), false)
                assert.equal(JSON.stringify(response).includes(credential.refreshToken), false)
            })
        }
    })

    test('classifies authentication, usage-limit, and generic HTTP failures', async (t) => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-access-token',
            refreshToken: 'private-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'account-id',
        } as const satisfies Credential
        const cases = [
            {
                name: 'unauthorized',
                status: 401,
                expectedMessage: 'OpenAI Codex authentication failed. Run yo login.',
            },
            {
                name: 'forbidden',
                status: 403,
                expectedMessage: 'OpenAI Codex authentication failed. Run yo login.',
            },
            {
                name: 'usage limit',
                status: 429,
                expectedMessage: 'OpenAI Codex usage limit reached. Try again later.',
            },
            {
                name: 'provider failure',
                status: 500,
                expectedMessage: 'OpenAI Codex request failed with status 500.',
            },
        ] as const

        for (const testCase of cases) {
            await t.test(testCase.name, async () => {
                const privatePayload = `private-${testCase.name}-provider-payload`
                const providerResponse = new Response(
                    JSON.stringify({
                        error: {
                            message: privatePayload,
                        },
                    }),
                    { status: testCase.status }
                )
                const transport = createOpenAICodexResponsesTransport({
                    credentialStore: unusedCredentialStore,
                    resolveCredential: async () => credential,
                    fetch: async () => providerResponse,
                })

                await assert.rejects(
                    transport({
                        model: null,
                        messages: [{ role: 'user', content: 'Inspect the workspace.' }],
                        visibleTools: ['read_file'],
                    }),
                    (error: unknown) => {
                        assert.equal(
                            error instanceof Error ? error.message : undefined,
                            testCase.expectedMessage
                        )
                        const visibleError = String(error)

                        assert.equal(visibleError.includes(privatePayload), false)
                        assert.equal(visibleError.includes(credential.accessToken), false)
                        assert.equal(visibleError.includes(credential.refreshToken), false)
                        return true
                    }
                )

                assert.equal(providerResponse.bodyUsed, false)
            })
        }
    })

    test('sanitizes rejected network requests', async () => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-access-token',
            refreshToken: 'private-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'account-id',
        } as const satisfies Credential
        const privateFailure = 'private-network-failure'
        const transport = createOpenAICodexResponsesTransport({
            credentialStore: unusedCredentialStore,
            resolveCredential: async () => credential,
            fetch: async () => {
                throw new Error(privateFailure)
            },
        })

        await assert.rejects(
            transport({
                model: null,
                messages: [{ role: 'user', content: 'Inspect the workspace.' }],
                visibleTools: ['read_file'],
            }),
            (error: unknown) => {
                assert.equal(
                    error instanceof Error ? error.message : undefined,
                    'OpenAI Codex network request failed.'
                )
                const visibleError = String(error)

                assert.equal(visibleError.includes(privateFailure), false)
                assert.equal(visibleError.includes(credential.accessToken), false)
                assert.equal(visibleError.includes(credential.refreshToken), false)
                return true
            }
        )
    })
})

describe('sendOpenAICodexResponsesRequest', () => {
    test('sends the prepared JSON body with the resolved OAuth credential', async () => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-refreshed-access-token',
            refreshToken: 'private-rotated-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'refreshed-account-id',
        } as const satisfies Credential
        const body = {
            model: 'test-model',
            stream: true,
            input: [{ role: 'user', content: 'Inspect the workspace.' }],
        } as const
        const expectedResponse = new Response('data: response.created\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        })
        let request:
            | {
                  input: string
                  init: RequestInit | undefined
              }
            | undefined

        const response = await sendOpenAICodexResponsesRequest({
            body,
            credentialStore: unusedCredentialStore,
            resolveCredential: async ({ credentialStore }) => {
                assert.equal(credentialStore, unusedCredentialStore)
                return credential
            },
            fetch: async (input, init) => {
                request = { input: input.toString(), init }
                return expectedResponse
            },
        })

        assert.equal(request?.input, 'https://chatgpt.com/backend-api/codex/responses')
        assert.equal(request?.init?.method, 'POST')
        assert.equal(request?.init?.body, JSON.stringify(body))

        const headers = new Headers(request?.init?.headers)

        assert.equal(headers.get('authorization'), `Bearer ${credential.accessToken}`)
        assert.equal(headers.get('chatgpt-account-id'), credential.accountId)
        assert.equal(headers.get('originator'), 'yo')
        assert.equal(headers.get('openai-beta'), 'responses=experimental')
        assert.equal(headers.get('accept'), 'text/event-stream')
        assert.equal(headers.get('content-type'), 'application/json')
        assert.equal(headers.has('x-api-key'), false)

        const transmittedRequest = JSON.stringify({
            headers: Object.fromEntries(headers),
            body: request?.init?.body,
        })

        assert.equal(transmittedRequest.includes(credential.refreshToken), false)
        assert.equal(transmittedRequest.includes(credential.expiresAt.toString()), false)
        assert.equal(response, expectedResponse)
        assert.equal(response.bodyUsed, false)
    })

    test('returns an unsuccessful HTTP response without reading its body', async () => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-access-token',
            refreshToken: 'private-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'account-id',
        } as const satisfies Credential
        const expectedResponse = new Response(
            JSON.stringify({
                error: {
                    code: 'unauthorized',
                    message: 'private-provider-response',
                },
            }),
            {
                status: 401,
                headers: { 'content-type': 'application/json' },
            }
        )

        const response = await sendOpenAICodexResponsesRequest({
            body: { stream: true },
            credentialStore: unusedCredentialStore,
            resolveCredential: async () => credential,
            fetch: async () => expectedResponse,
        })

        assert.equal(response, expectedResponse)
        assert.equal(response.status, 401)
        assert.equal(response.bodyUsed, false)
    })

    test('requires login without sending a request when no credential is stored', async () => {
        let requestCount = 0

        await assert.rejects(
            sendOpenAICodexResponsesRequest({
                body: { stream: true },
                credentialStore: unusedCredentialStore,
                resolveCredential: async () => undefined,
                fetch: async () => {
                    requestCount += 1
                    return new Response()
                },
            }),
            (error: unknown) => {
                assert.equal(
                    error instanceof Error ? error.message : undefined,
                    'OpenAI Codex authentication is required. Run yo login.'
                )
                assert.equal(String(error).includes('private-access-token'), false)
                assert.equal(String(error).includes('private-refresh-token'), false)
                return true
            }
        )

        assert.equal(requestCount, 0)
    })
})
