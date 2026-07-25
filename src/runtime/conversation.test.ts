import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
    appendTurnToConversation,
    createConversation,
    createConversationTurnResult,
    runConversationTurn,
    type ModelRequest,
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

test('continues one bounded turn from the conversation transcript', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'yo-conversation-turn-'))
    await writeFile(join(workspaceRoot, 'entry.ts'), 'export const entry = true\n')
    const conversation = createConversation({
        systemPrompt: 'Use read-only tools.',
        workspaceRoot,
        model: 'faux-model',
    })
    const requests: ModelRequest[] = []
    let requestCount = 0

    const result = await runConversationTurn({
        conversation,
        task: 'Find the entrypoint.',
        budget: { maxSteps: 2, perToolTimeoutMs: 1_000 },
        transport: async (request) => {
            requests.push(request)
            requestCount += 1

            if (requestCount === 1) {
                return {
                    type: 'tool_calls',
                    model: 'faux-model',
                    toolCalls: [
                        {
                            id: 'call-1',
                            name: 'search_code',
                            arguments: { query: 'entry' },
                        },
                    ],
                }
            }

            return {
                type: 'final_answer',
                model: 'faux-model',
                content: 'The entrypoint is entry.ts.',
            }
        },
    })

    assert.deepEqual(requests[0]?.messages, [
        { role: 'system', content: 'Use read-only tools.' },
        { role: 'user', content: 'Find the entrypoint.' },
    ])
    assert.equal(requests[1]?.messages[2]?.role, 'assistant')
    assert.equal(requests[1]?.messages[3]?.role, 'tool')
    assert.deepEqual(result.conversation.messages, result.turn.session.messages)
    assert.equal(result.turn.session.stepCount, 2)
    assert.equal(result.turn.session.events[0]?.type, 'run_started')
    assert.equal(result.conversation.workspaceRoot, workspaceRoot)
    assert.equal(result.conversation.model, 'faux-model')
    assert.equal(conversation.messages.length, 1)

    const assistantMessage = result.turn.session.messages[2]!
    assert.equal(assistantMessage.role, 'assistant')
    assistantMessage.content = 'Changed after the turn.'
    assert.equal(result.conversation.messages[2]?.role, 'assistant')
    assert.notEqual(result.conversation.messages[2]?.content, assistantMessage.content)
})

test('retains a failed or budget-exhausted bounded turn without recovery', async () => {
    const conversation = createConversation({
        systemPrompt: 'Use read-only tools.',
        workspaceRoot: '/approved/workspace',
        model: null,
    })
    const budget = { maxSteps: 1, perToolTimeoutMs: 1_000 }

    const failed = await runConversationTurn({
        conversation,
        task: 'Try the transport.',
        budget,
        transport: async () => Promise.reject(new Error('private provider failure')),
    })
    const exhausted = await runConversationTurn({
        conversation,
        task: 'Use one tool.',
        budget,
        transport: async () => ({
            type: 'tool_calls',
            model: null,
            toolCalls: [
                {
                    id: 'call-1',
                    name: 'search_code',
                    arguments: { query: 'entry' },
                },
            ],
        }),
    })

    assert.equal(failed.turn.session.status, 'failed')
    assert.equal(failed.turn.session.stopReason, 'transport_error')
    assert.deepEqual(failed.conversation.messages, [
        { role: 'system', content: 'Use read-only tools.' },
        { role: 'user', content: 'Try the transport.' },
    ])
    assert.equal(exhausted.turn.session.status, 'aborted')
    assert.equal(exhausted.turn.session.stopReason, 'step_budget_exhausted')
    assert.equal(exhausted.turn.session.stepCount, 1)
    assert.equal(exhausted.conversation.messages[1]?.role, 'user')
    assert.equal(exhausted.conversation.messages[2]?.role, 'assistant')
    assert.equal(exhausted.conversation.messages[3]?.role, 'tool')
})
