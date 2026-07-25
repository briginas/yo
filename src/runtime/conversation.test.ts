import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    appendTurnToConversation,
    createConversation,
    createConversationTurnResult,
    type SessionState,
} from './index.ts'

const createSession = (
    messages: SessionState['messages'],
    status: SessionState['status'] = 'completed'
): SessionState => ({
    task: 'Inspect the runtime.',
    workspaceRoot: '/approved/workspace',
    budget: {
        maxSteps: 10,
        perToolTimeoutMs: 1_000,
    },
    status,
    stepCount: 1,
    messages,
    events: [],
    finalAnswer: status === 'completed' ? 'Done.' : null,
    stopReason: status === 'completed' ? 'final_answer' : 'transport_error',
})

test('creates an in-memory conversation with one system message and fixed settings', () => {
    const conversation = createConversation({
        systemPrompt: 'Use read-only tools.',
        workspaceRoot: '/approved/workspace',
        model: 'faux-model',
    })

    assert.deepEqual(conversation, {
        workspaceRoot: '/approved/workspace',
        model: 'faux-model',
        messages: [
            {
                role: 'system',
                content: 'Use read-only tools.',
            },
        ],
    })
})

test('appends a completed turn in provider-neutral transcript order', () => {
    const conversation = createConversation({
        systemPrompt: 'Use read-only tools.',
        workspaceRoot: '/approved/workspace',
        model: null,
    })
    const session = createSession([
        { role: 'system', content: 'Use read-only tools.' },
        { role: 'user', content: 'Find the entrypoint.' },
        {
            role: 'assistant',
            content: 'I will search.',
            toolCalls: [
                {
                    id: 'call-1',
                    name: 'search_code',
                    arguments: { query: 'runAgent' },
                },
            ],
        },
        {
            role: 'tool',
            result: {
                status: 'success',
                callId: 'call-1',
                content: 'src/runtime/agent-loop.ts:237:export const runAgent',
                metadata: { truncated: false, truncation: null },
            },
        },
        { role: 'assistant', content: 'The entrypoint is agent-loop.ts.', toolCalls: [] },
    ])

    const turn = createConversationTurnResult(session)
    const updated = appendTurnToConversation(conversation, turn)

    assert.deepEqual(updated.messages, [
        { role: 'system', content: 'Use read-only tools.' },
        { role: 'user', content: 'Find the entrypoint.' },
        {
            role: 'assistant',
            content: 'I will search.',
            toolCalls: [
                {
                    id: 'call-1',
                    name: 'search_code',
                    arguments: { query: 'runAgent' },
                },
            ],
        },
        {
            role: 'tool',
            result: {
                status: 'success',
                callId: 'call-1',
                content: 'src/runtime/agent-loop.ts:237:export const runAgent',
                metadata: { truncated: false, truncation: null },
            },
        },
        { role: 'assistant', content: 'The entrypoint is agent-loop.ts.', toolCalls: [] },
    ])
    assert.notEqual(updated, conversation)
    assert.equal(updated.workspaceRoot, conversation.workspaceRoot)
    assert.equal(updated.model, conversation.model)
})

test('retains a failed turn transcript without sharing it with the session', () => {
    const session = createSession(
        [
            { role: 'system', content: 'Use read-only tools.' },
            { role: 'user', content: 'Inspect the runtime.' },
        ],
        'failed'
    )
    const turn = createConversationTurnResult(session)
    const conversation = appendTurnToConversation(
        createConversation({
            systemPrompt: 'Use read-only tools.',
            workspaceRoot: '/approved/workspace',
            model: null,
        }),
        turn
    )

    const userMessage = session.messages[1]!

    assert.equal(userMessage.role, 'user')
    userMessage.content = 'Changed after the turn.'

    assert.deepEqual(conversation.messages, [
        { role: 'system', content: 'Use read-only tools.' },
        { role: 'user', content: 'Inspect the runtime.' },
    ])
    assert.equal(turn.session, session)
    assert.equal(conversation.messages.includes(userMessage), false)
})
