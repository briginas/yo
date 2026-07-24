import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Credential, CredentialStore } from '../auth/credential.ts'
import type { ModelRequest } from '../runtime/run.ts'
import {
    buildOpenAICodexResponsesRequestBody,
    convertModelRequestToOpenAICodex,
    convertOpenAICodexOutputToModelResponse,
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
            converted.tools.map((tool) => tool.strict),
            [null, null, null]
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
        const { model, reasoning, ...conversion } = body

        assert.equal(model, 'gpt-5.6-terra')
        assert.deepEqual(reasoning, { effort: 'medium' })
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
