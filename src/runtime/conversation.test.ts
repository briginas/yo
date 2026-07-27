import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
    appendTurnToConversation,
    createConversation,
    createConversationTurnResult,
    runConversationTurn,
    type ModelTransport,
    type ModelRequest,
    type SessionState,
    canonicalizeWorkspaceRoot,
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

test('uses the bounded read-only system prompt by default', () => {
    const conversation = createConversation({
        workspaceRoot: '/approved/workspace',
        model: null,
    })

    assert.deepEqual(conversation.messages, [
        {
            role: 'system',
            content:
                'You are a read-only coding agent. Inspect only the approved workspace through the available read-only tools and base your final answer on tool results.',
        },
    ])
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

test('retains prior tool observations for a grounded second turn', async () => {
    const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'yo-conversation-context-')))
    await writeFile(join(workspaceRoot, 'entry.ts'), 'export const entry = true\n')
    const initialWorkspaceEntries = await readdir(workspaceRoot)
    const initialConversation = createConversation({
        systemPrompt: 'Use read-only tools.',
        workspaceRoot,
        model: 'faux-model',
    })
    const requests: ModelRequest[] = []
    let requestCount = 0
    const transport: ModelTransport = async (request) => {
        requests.push(request)
        requestCount += 1

        switch (requestCount) {
            case 1:
                return {
                    type: 'tool_calls' as const,
                    model: 'faux-model',
                    content: 'I will search for the entrypoint.',
                    toolCalls: [
                        {
                            id: 'search-entry',
                            name: 'search_code',
                            arguments: { query: 'entry' },
                        },
                    ],
                }
            case 2:
                return {
                    type: 'tool_calls' as const,
                    model: 'faux-model',
                    content: 'I will read the matching file.',
                    toolCalls: [
                        {
                            id: 'read-entry',
                            name: 'read_file',
                            arguments: { path: 'entry.ts' },
                        },
                    ],
                }
            case 3:
                return {
                    type: 'final_answer' as const,
                    model: 'faux-model',
                    content: 'The entrypoint is entry.ts.',
                }
            case 4:
                return {
                    type: 'final_answer' as const,
                    model: 'faux-model',
                    content: 'It exports entry with the value true.',
                }
            default:
                throw new Error('Unexpected model request.')
        }
    }
    const budget = { maxSteps: 3, perToolTimeoutMs: 1_000 }

    const firstTurn = await runConversationTurn({
        conversation: initialConversation,
        task: 'Find the entrypoint.',
        budget,
        transport,
    })
    const secondTurn = await runConversationTurn({
        conversation: firstTurn.conversation,
        task: 'What does the entrypoint export?',
        budget,
        transport,
    })

    assert.equal(requests.length, 4)
    assert.deepEqual(requests[3]?.messages, [
        { role: 'system', content: 'Use read-only tools.' },
        { role: 'user', content: 'Find the entrypoint.' },
        {
            role: 'assistant',
            content: 'I will search for the entrypoint.',
            toolCalls: [
                {
                    id: 'search-entry',
                    name: 'search_code',
                    arguments: { query: 'entry' },
                },
            ],
        },
        {
            role: 'tool',
            result: {
                status: 'success',
                callId: 'search-entry',
                content: 'entry.ts:1:export const entry = true',
                metadata: { truncated: false, truncation: null },
            },
        },
        {
            role: 'assistant',
            content: 'I will read the matching file.',
            toolCalls: [
                {
                    id: 'read-entry',
                    name: 'read_file',
                    arguments: { path: 'entry.ts' },
                },
            ],
        },
        {
            role: 'tool',
            result: {
                status: 'success',
                callId: 'read-entry',
                content: '1:export const entry = true',
                metadata: { truncated: false, truncation: null },
            },
        },
        {
            role: 'assistant',
            content: 'The entrypoint is entry.ts.',
            toolCalls: [],
        },
        { role: 'user', content: 'What does the entrypoint export?' },
    ])
    assert.deepEqual(
        secondTurn.conversation.messages.map((message) => message.role),
        [
            'system',
            'user',
            'assistant',
            'tool',
            'assistant',
            'tool',
            'assistant',
            'user',
            'assistant',
        ]
    )
    assert.equal(
        secondTurn.conversation.messages.filter((message) => message.role === 'system').length,
        1
    )
    assert.equal(
        secondTurn.conversation.messages.filter((message) => message.role === 'user').length,
        2
    )
    assert.equal(firstTurn.turn.session.stepCount, 3)
    assert.equal(secondTurn.turn.session.stepCount, 1)
    assert.equal(secondTurn.conversation.workspaceRoot, workspaceRoot)
    assert.equal(secondTurn.conversation.model, 'faux-model')
    assert.deepEqual(await readdir(workspaceRoot), initialWorkspaceEntries)
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

test('passes a patch approver through a turn without adding approval input to the conversation', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-conversation-patch-'))
    const workspaceRoot = await canonicalizeWorkspaceRoot(fixtureRoot)
    await writeFile(join(workspaceRoot, 'entry.ts'), 'export const value = 1\n')
    const conversation = createConversation({
        systemPrompt: 'Use read-only tools.',
        workspaceRoot,
        model: 'faux-model',
    })
    let requestCount = 0
    let approvalCount = 0

    const result = await runConversationTurn({
        conversation,
        task: 'Update the entry.',
        budget: { maxSteps: 2, perToolTimeoutMs: 1_000 },
        transport: async () => {
            requestCount += 1

            return requestCount === 1
                ? {
                      type: 'tool_calls' as const,
                      model: 'faux-model',
                      toolCalls: [
                          {
                              id: 'patch-entry',
                              name: 'propose_patch',
                              arguments: {
                                  path: 'entry.ts',
                                  edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
                              },
                          },
                      ],
                  }
                : { type: 'final_answer' as const, model: 'faux-model', content: 'Updated.' }
        },
        patchApprover: async () => {
            approvalCount += 1

            return 'approved'
        },
    })

    assert.equal(approvalCount, 1)
    assert.equal(
        await readFile(join(workspaceRoot, 'entry.ts'), 'utf8'),
        'export const value = 2\n'
    )
    assert.deepEqual(
        result.conversation.messages.map((message) => message.role),
        ['system', 'user', 'assistant', 'tool', 'assistant']
    )
    assert.equal(
        result.conversation.messages.some(
            (message) => message.role === 'user' && message.content === 'yes'
        ),
        false
    )
})
