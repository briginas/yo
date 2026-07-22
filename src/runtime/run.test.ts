import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ModelRequest, ModelResponse, ModelTransport, SessionMessage } from './index.ts'

const createModelRequest = (): ModelRequest => ({
    model: null,
    messages: [
        {
            role: 'system',
            content: 'Inspect the approved workspace using read-only tools.',
        },
        {
            role: 'user',
            content: 'Find the runtime entrypoint.',
        },
    ],
    visibleTools: ['list_files', 'search_code', 'read_file'],
})

test('model transport receives context and returns a final answer', async () => {
    const request = createModelRequest()
    let receivedRequest: ModelRequest | null = null

    const transport: ModelTransport = async (modelRequest) => {
        receivedRequest = modelRequest

        return {
            type: 'final_answer',
            model: null,
            content: 'The runtime entrypoint is src/runtime/index.ts.',
        }
    }

    const response = await transport(request)

    assert.deepEqual(receivedRequest, request)
    assert.deepEqual(response, {
        type: 'final_answer',
        model: null,
        content: 'The runtime entrypoint is src/runtime/index.ts.',
    })
})

test('model transport preserves assistant text and untrusted tool calls', async () => {
    const untrustedArguments: unknown = {
        command: 'write outside the workspace',
    }
    const toolResponse: ModelResponse = {
        type: 'tool_calls',
        model: 'faux-model',
        content: 'I will inspect the workspace first.',
        toolCalls: [
            {
                id: 'call-1',
                name: 'unknown_tool',
                arguments: untrustedArguments,
            },
        ],
    }
    const transport: ModelTransport = async () => toolResponse

    const response = await transport(createModelRequest())

    assert.equal(response.type, 'tool_calls')
    assert.equal(response.content, 'I will inspect the workspace first.')
    assert.equal(response.toolCalls[0].name, 'unknown_tool')
    assert.equal(response.toolCalls[0].arguments, untrustedArguments)

    const assistantMessage: SessionMessage = {
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: [...response.toolCalls],
    }

    assert.deepEqual(assistantMessage, {
        role: 'assistant',
        content: 'I will inspect the workspace first.',
        toolCalls: toolResponse.toolCalls,
    })
})
