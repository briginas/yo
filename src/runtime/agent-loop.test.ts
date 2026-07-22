import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runAgent } from './agent-loop.ts'
import type { ModelRequest, ModelTransport } from './run.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

const budget = {
    maxSteps: 3,
    perToolTimeoutMs: 1_000,
}

test('completes an in-memory session when the model returns a final answer', async () => {
    const requests: ModelRequest[] = []
    const transport: ModelTransport = async (request) => {
        requests.push(request)

        return {
            type: 'final_answer',
            model: 'faux-model',
            content: 'The runtime entrypoint is src/runtime/index.ts.',
        }
    }

    const session = await runAgent({
        task: 'Find the runtime entrypoint.',
        workspaceRoot: '/approved/workspace',
        budget,
        model: 'faux-model',
        transport,
    })

    assert.deepEqual(requests, [
        {
            model: 'faux-model',
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a read-only coding agent. Inspect only the approved workspace through the available read-only tools and base your final answer on tool results.',
                },
                {
                    role: 'user',
                    content: 'Find the runtime entrypoint.',
                },
            ],
            visibleTools: ['list_files', 'search_code', 'read_file'],
        },
    ])
    assert.deepEqual(session, {
        task: 'Find the runtime entrypoint.',
        workspaceRoot: '/approved/workspace',
        budget,
        status: 'completed',
        stepCount: 1,
        messages: [
            ...requests[0]!.messages,
            {
                role: 'assistant',
                content: 'The runtime entrypoint is src/runtime/index.ts.',
                toolCalls: [],
            },
        ],
        events: [],
        finalAnswer: 'The runtime entrypoint is src/runtime/index.ts.',
        stopReason: 'final_answer',
    })
})

test('returns a read-only tool result to the model on the next step', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-agent-loop-'))
    const workspace = join(fixtureRoot, 'workspace')
    const sourceDirectory = join(workspace, 'src')

    try {
        await mkdir(sourceDirectory, { recursive: true })
        await writeFile(join(sourceDirectory, 'agent.ts'), "export const answer = 'found'\n")

        const workspaceRoot = await canonicalizeWorkspaceRoot(workspace)
        const requests: ModelRequest[] = []
        const transport: ModelTransport = async (request) => {
            requests.push(request)

            if (requests.length === 1) {
                return {
                    type: 'tool_calls',
                    model: 'faux-model',
                    content: 'I will read the relevant file.',
                    toolCalls: [
                        {
                            id: 'read-call',
                            name: 'read_file',
                            arguments: { path: 'src/agent.ts' },
                        },
                    ],
                }
            }

            return {
                type: 'final_answer',
                model: 'faux-model',
                content: 'The answer is defined in src/agent.ts:1.',
            }
        }

        const session = await runAgent({
            task: 'Find the answer.',
            workspaceRoot,
            budget,
            model: 'faux-model',
            transport,
        })

        assert.equal(requests.length, 2)
        assert.equal(requests[0]!.messages.length, 2)
        assert.deepEqual(requests[1]!.messages.slice(2), [
            {
                role: 'assistant',
                content: 'I will read the relevant file.',
                toolCalls: [
                    {
                        id: 'read-call',
                        name: 'read_file',
                        arguments: { path: 'src/agent.ts' },
                    },
                ],
            },
            {
                role: 'tool',
                result: {
                    status: 'success',
                    callId: 'read-call',
                    content: "1:export const answer = 'found'",
                    metadata: {
                        truncated: false,
                        truncation: null,
                    },
                },
            },
        ])
        assert.equal(session.status, 'completed')
        assert.equal(session.stepCount, 2)
        assert.equal(session.finalAnswer, 'The answer is defined in src/agent.ts:1.')
        assert.equal(session.stopReason, 'final_answer')
        assert.deepEqual(session.events, [])
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('preserves multiple tool-call ordering in the completed session', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-agent-loop-multiple-'))
    const workspace = join(fixtureRoot, 'workspace')
    const sourceDirectory = join(workspace, 'src')

    try {
        await mkdir(sourceDirectory, { recursive: true })
        await writeFile(join(sourceDirectory, 'agent.ts'), "export const answer = 'found'\n")

        const workspaceRoot = await canonicalizeWorkspaceRoot(workspace)
        const requests: ModelRequest[] = []
        const transport: ModelTransport = async (request) => {
            requests.push(request)

            if (requests.length === 1) {
                return {
                    type: 'tool_calls',
                    model: 'faux-model',
                    content: 'I will search for the answer and then read its source file.',
                    toolCalls: [
                        {
                            id: 'search-call',
                            name: 'search_code',
                            arguments: { query: 'answer', path: 'src' },
                        },
                        {
                            id: 'read-call',
                            name: 'read_file',
                            arguments: { path: 'src/agent.ts' },
                        },
                    ],
                }
            }

            return {
                type: 'final_answer',
                model: 'faux-model',
                content: 'The answer is defined in src/agent.ts:1.',
            }
        }

        const session = await runAgent({
            task: 'Find the answer and inspect its definition.',
            workspaceRoot,
            budget,
            model: 'faux-model',
            transport,
        })

        assert.equal(requests.length, 2)
        assert.deepEqual(requests[1]!.messages.slice(2), [
            {
                role: 'assistant',
                content: 'I will search for the answer and then read its source file.',
                toolCalls: [
                    {
                        id: 'search-call',
                        name: 'search_code',
                        arguments: { query: 'answer', path: 'src' },
                    },
                    {
                        id: 'read-call',
                        name: 'read_file',
                        arguments: { path: 'src/agent.ts' },
                    },
                ],
            },
            {
                role: 'tool',
                result: {
                    status: 'success',
                    callId: 'search-call',
                    content: "src/agent.ts:1:export const answer = 'found'",
                    metadata: {
                        truncated: false,
                        truncation: null,
                    },
                },
            },
            {
                role: 'tool',
                result: {
                    status: 'success',
                    callId: 'read-call',
                    content: "1:export const answer = 'found'",
                    metadata: {
                        truncated: false,
                        truncation: null,
                    },
                },
            },
        ])
        assert.deepEqual(session, {
            task: 'Find the answer and inspect its definition.',
            workspaceRoot,
            budget,
            status: 'completed',
            stepCount: 2,
            messages: [
                ...requests[1]!.messages,
                {
                    role: 'assistant',
                    content: 'The answer is defined in src/agent.ts:1.',
                    toolCalls: [],
                },
            ],
            events: [],
            finalAnswer: 'The answer is defined in src/agent.ts:1.',
            stopReason: 'final_answer',
        })
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('stops after the model-request budget without dropping the last tool result', async () => {
    let requestCount = 0
    const transport: ModelTransport = async () => {
        requestCount += 1

        return {
            type: 'tool_calls',
            model: null,
            toolCalls: [
                {
                    id: 'unknown-call',
                    name: 'unknown_tool',
                    arguments: null,
                },
            ],
        }
    }

    const session = await runAgent({
        task: 'Inspect the workspace.',
        workspaceRoot: '/approved/workspace',
        budget: {
            maxSteps: 1,
            perToolTimeoutMs: 1_000,
        },
        model: null,
        transport,
    })

    assert.equal(requestCount, 1)
    assert.equal(session.stepCount, 1)
    assert.equal(session.status, 'aborted')
    assert.equal(session.finalAnswer, null)
    assert.equal(session.stopReason, 'step_budget_exhausted')
    assert.deepEqual(session.messages.slice(-1), [
        {
            role: 'tool',
            result: {
                status: 'unknown_tool',
                callId: 'unknown-call',
                content: 'Unknown tool: unknown_tool',
                metadata: {
                    truncated: false,
                    truncation: null,
                },
                error: {
                    code: 'unknown_tool',
                    message: 'Unknown tool: unknown_tool',
                },
            },
        },
    ])

    const zeroStepSession = await runAgent({
        task: 'Do not start.',
        workspaceRoot: '/approved/workspace',
        budget: {
            maxSteps: 0,
            perToolTimeoutMs: 1_000,
        },
        model: null,
        transport,
    })

    assert.equal(requestCount, 1)
    assert.equal(zeroStepSession.stepCount, 0)
    assert.equal(zeroStepSession.status, 'aborted')
    assert.equal(zeroStepSession.stopReason, 'step_budget_exhausted')
})
