import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runAgent, runAgentWithDispatcher } from './agent-loop.ts'
import type { ModelRequest, ModelTransport, SessionState } from './run.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

const budget = {
    maxSteps: 3,
    perToolTimeoutMs: 1_000,
}

const toolResultCount = (session: SessionState, callId: string): number =>
    session.messages.filter(
        (message) => message.role === 'tool' && message.result.callId === callId
    ).length

const toolCompletedCount = (session: SessionState, callId: string): number =>
    session.events.filter(
        (event) => event.type === 'tool_completed' && event.result.callId === callId
    ).length

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
        events: [
            {
                type: 'run_started',
                task: 'Find the runtime entrypoint.',
                workspaceRoot: '/approved/workspace',
                budget,
            },
            {
                type: 'model_requested',
                step: 1,
                metadata: {
                    model: 'faux-model',
                    visibleTools: ['list_files', 'search_code', 'read_file'],
                },
            },
            {
                type: 'model_responded',
                step: 1,
                metadata: {
                    model: 'faux-model',
                    toolCallCount: 0,
                    hasFinalAnswer: true,
                },
            },
            {
                type: 'final_answer',
                answer: 'The runtime entrypoint is src/runtime/index.ts.',
            },
            {
                type: 'run_finished',
                status: 'completed',
                reason: 'final_answer',
            },
        ],
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
        assert.deepEqual(session.events, [
            {
                type: 'run_started',
                task: 'Find the answer.',
                workspaceRoot,
                budget,
            },
            {
                type: 'model_requested',
                step: 1,
                metadata: {
                    model: 'faux-model',
                    visibleTools: ['list_files', 'search_code', 'read_file'],
                },
            },
            {
                type: 'model_responded',
                step: 1,
                metadata: {
                    model: 'faux-model',
                    toolCallCount: 1,
                    hasFinalAnswer: false,
                },
            },
            {
                type: 'tool_requested',
                step: 1,
                call: {
                    id: 'read-call',
                    name: 'read_file',
                    arguments: { path: 'src/agent.ts' },
                },
            },
            {
                type: 'tool_authorized',
                step: 1,
                callId: 'read-call',
                decision: { decision: 'allow' },
            },
            {
                type: 'tool_completed',
                step: 1,
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
            {
                type: 'model_requested',
                step: 2,
                metadata: {
                    model: 'faux-model',
                    visibleTools: ['list_files', 'search_code', 'read_file'],
                },
            },
            {
                type: 'model_responded',
                step: 2,
                metadata: {
                    model: 'faux-model',
                    toolCallCount: 0,
                    hasFinalAnswer: true,
                },
            },
            {
                type: 'final_answer',
                answer: 'The answer is defined in src/agent.ts:1.',
            },
            {
                type: 'run_finished',
                status: 'completed',
                reason: 'final_answer',
            },
        ])
        assert.equal(toolResultCount(session, 'read-call'), 1)
        assert.equal(toolCompletedCount(session, 'read-call'), 1)
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('completes the PRD search-then-read scenario with a faux transport', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-agent-loop-prd-'))
    const workspace = join(fixtureRoot, 'workspace')
    const sourceDirectory = join(workspace, 'src')

    try {
        await mkdir(sourceDirectory, { recursive: true })
        await writeFile(join(sourceDirectory, 'agent.ts'), "export const answer = 'found'\n")

        const workspaceRoot = await canonicalizeWorkspaceRoot(workspace)
        const requests: ModelRequest[] = []
        const searchCall = {
            id: 'search-call',
            name: 'search_code' as const,
            arguments: { query: 'answer', path: 'src' },
        }
        const readCall = {
            id: 'read-call',
            name: 'read_file' as const,
            arguments: { path: 'src/agent.ts' },
        }
        const searchResult = {
            status: 'success' as const,
            callId: searchCall.id,
            content: "src/agent.ts:1:export const answer = 'found'",
            metadata: {
                truncated: false,
                truncation: null,
            },
        }
        const readResult = {
            status: 'success' as const,
            callId: readCall.id,
            content: "1:export const answer = 'found'",
            metadata: {
                truncated: false,
                truncation: null,
            },
        }
        const transport: ModelTransport = async (request) => {
            requests.push(request)

            if (requests.length === 1) {
                return {
                    type: 'tool_calls',
                    model: 'faux-model',
                    content: 'I will search for the relevant definition.',
                    toolCalls: [searchCall],
                }
            }

            if (requests.length === 2) {
                return {
                    type: 'tool_calls',
                    model: 'faux-model',
                    content: 'The search found a candidate, so I will read it.',
                    toolCalls: [readCall],
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

        assert.equal(requests.length, 3)
        assert.deepEqual(requests[1]!.messages.slice(2), [
            {
                role: 'assistant',
                content: 'I will search for the relevant definition.',
                toolCalls: [searchCall],
            },
            {
                role: 'tool',
                result: searchResult,
            },
        ])
        assert.deepEqual(requests[2]!.messages.slice(2), [
            ...requests[1]!.messages.slice(2),
            {
                role: 'assistant',
                content: 'The search found a candidate, so I will read it.',
                toolCalls: [readCall],
            },
            {
                role: 'tool',
                result: readResult,
            },
        ])
        assert.equal(session.status, 'completed')
        assert.equal(session.stepCount, 3)
        assert.equal(session.finalAnswer, 'The answer is defined in src/agent.ts:1.')
        assert.equal(session.stopReason, 'final_answer')
        assert.deepEqual(
            session.messages
                .filter((message) => message.role === 'tool')
                .map((message) =>
                    message.role === 'tool'
                        ? [message.result.callId, message.result.status]
                        : assert.fail('Expected a tool message')
                ),
            [
                ['search-call', 'success'],
                ['read-call', 'success'],
            ]
        )
        assert.deepEqual(
            session.events
                .filter(
                    (event) => event.type === 'tool_requested' || event.type === 'tool_completed'
                )
                .map((event) => {
                    if (event.type === 'tool_requested') {
                        return [event.type, event.call.id]
                    }

                    if (event.type === 'tool_completed') {
                        return [event.type, event.result.callId, event.result.status]
                    }

                    return assert.fail('Unexpected tool event')
                }),
            [
                ['tool_requested', 'search-call'],
                ['tool_completed', 'search-call', 'success'],
                ['tool_requested', 'read-call'],
                ['tool_completed', 'read-call', 'success'],
            ]
        )
        for (const callId of ['search-call', 'read-call']) {
            assert.equal(toolResultCount(session, callId), 1)
            assert.equal(toolCompletedCount(session, callId), 1)
        }
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
        const { events, ...sessionWithoutEvents } = session

        assert.deepEqual(sessionWithoutEvents, {
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
            finalAnswer: 'The answer is defined in src/agent.ts:1.',
            stopReason: 'final_answer',
        })
        assert.deepEqual(
            events
                .filter((event) => event.type.startsWith('tool_'))
                .map((event) => {
                    if (event.type === 'tool_requested') {
                        return [event.type, event.call.id]
                    }

                    if (event.type === 'tool_authorized') {
                        return [event.type, event.callId]
                    }

                    if (event.type === 'tool_completed') {
                        return [event.type, event.result.callId]
                    }

                    return assert.fail(`Unexpected tool event: ${event.type}`)
                }),
            [
                ['tool_requested', 'search-call'],
                ['tool_authorized', 'search-call'],
                ['tool_completed', 'search-call'],
                ['tool_requested', 'read-call'],
                ['tool_authorized', 'read-call'],
                ['tool_completed', 'read-call'],
            ]
        )
        for (const callId of ['search-call', 'read-call']) {
            assert.equal(toolResultCount(session, callId), 1)
            assert.equal(toolCompletedCount(session, callId), 1)
        }
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('returns exactly one timeout result to the model and continues the loop', async () => {
    const requests: ModelRequest[] = []
    const transport: ModelTransport = async (request) => {
        requests.push(request)

        if (requests.length === 1) {
            return {
                type: 'tool_calls',
                model: 'faux-model',
                toolCalls: [
                    {
                        id: 'slow-read',
                        name: 'read_file',
                        arguments: { path: 'src/slow.ts' },
                    },
                ],
            }
        }

        return {
            type: 'final_answer',
            model: 'faux-model',
            content: 'The read timed out before producing evidence.',
        }
    }
    const dispatchedCalls: Array<{ callId: string; timeoutMs: number }> = []

    const session = await runAgentWithDispatcher(
        {
            task: 'Inspect the slow file.',
            workspaceRoot: '/approved/workspace',
            budget: {
                maxSteps: 2,
                perToolTimeoutMs: 25,
            },
            model: 'faux-model',
            transport,
        },
        async (_workspaceRoot, call, timeoutMs) => {
            dispatchedCalls.push({ callId: call.id, timeoutMs })
            const message = `Tool execution timed out after ${timeoutMs} ms`

            return {
                status: 'timeout',
                callId: call.id,
                content: message,
                metadata: {
                    truncated: false,
                    truncation: null,
                },
                error: {
                    code: 'timeout',
                    message,
                },
            }
        }
    )

    assert.deepEqual(dispatchedCalls, [{ callId: 'slow-read', timeoutMs: 25 }])
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1]!.messages.slice(-1), [
        {
            role: 'tool',
            result: {
                status: 'timeout',
                callId: 'slow-read',
                content: 'Tool execution timed out after 25 ms',
                metadata: {
                    truncated: false,
                    truncation: null,
                },
                error: {
                    code: 'timeout',
                    message: 'Tool execution timed out after 25 ms',
                },
            },
        },
    ])
    assert.equal(toolResultCount(session, 'slow-read'), 1)
    assert.equal(toolCompletedCount(session, 'slow-read'), 1)
    assert.deepEqual(
        session.events
            .filter(
                (event) => event.type === 'tool_completed' && event.result.callId === 'slow-read'
            )
            .map((event) => (event.type === 'tool_completed' ? event.result.status : null)),
        ['timeout']
    )
    assert.equal(session.status, 'completed')
    assert.equal(session.finalAnswer, 'The read timed out before producing evidence.')
    assert.equal(session.stopReason, 'final_answer')
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
    assert.equal(toolResultCount(session, 'unknown-call'), 1)
    assert.equal(toolCompletedCount(session, 'unknown-call'), 1)
    assert.deepEqual(session.events.slice(-3), [
        {
            type: 'tool_authorized',
            step: 1,
            callId: 'unknown-call',
            decision: { decision: 'deny', reason: 'unknown_tool' },
        },
        {
            type: 'tool_completed',
            step: 1,
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
        {
            type: 'run_finished',
            status: 'aborted',
            reason: 'step_budget_exhausted',
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
    assert.deepEqual(zeroStepSession.events, [
        {
            type: 'run_started',
            task: 'Do not start.',
            workspaceRoot: '/approved/workspace',
            budget: {
                maxSteps: 0,
                perToolTimeoutMs: 1_000,
            },
        },
        {
            type: 'run_finished',
            status: 'aborted',
            reason: 'step_budget_exhausted',
        },
    ])
})

test('records validation, permission, and execution outcomes once per requested tool', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-agent-loop-outcomes-'))
    const workspace = join(fixtureRoot, 'workspace')

    try {
        await mkdir(workspace, { recursive: true })
        await writeFile(join(workspace, 'binary.dat'), Buffer.from([0, 1, 2]))

        const workspaceRoot = await canonicalizeWorkspaceRoot(workspace)
        let requestCount = 0
        const transport: ModelTransport = async () => {
            requestCount += 1

            if (requestCount === 1) {
                return {
                    type: 'tool_calls',
                    model: 'faux-model',
                    toolCalls: [
                        {
                            id: 'invalid-call',
                            name: 'read_file',
                            arguments: { path: 'binary.dat', startLine: 0 },
                        },
                        {
                            id: 'denied-call',
                            name: 'read_file',
                            arguments: { path: '../outside.txt' },
                        },
                        {
                            id: 'execution-call',
                            name: 'read_file',
                            arguments: { path: 'binary.dat' },
                        },
                    ],
                }
            }

            return {
                type: 'final_answer',
                model: 'faux-model',
                content: 'No readable evidence was returned.',
            }
        }

        const session = await runAgent({
            task: 'Inspect all requested paths.',
            workspaceRoot,
            budget,
            model: 'faux-model',
            transport,
        })

        const expectedStatuses = new Map([
            ['invalid-call', 'invalid_arguments'],
            ['denied-call', 'denied'],
            ['execution-call', 'execution_error'],
        ])

        for (const [callId, status] of expectedStatuses) {
            const completedEvent = session.events.find(
                (event) => event.type === 'tool_completed' && event.result.callId === callId
            )

            assert.equal(toolResultCount(session, callId), 1)
            assert.equal(toolCompletedCount(session, callId), 1)

            if (completedEvent?.type !== 'tool_completed') {
                assert.fail(`Missing tool_completed event for ${callId}`)
            }

            assert.equal(completedEvent.result.status, status)
        }

        assert.deepEqual(
            session.events
                .filter((event) => event.type === 'tool_authorized')
                .map((event) =>
                    event.type === 'tool_authorized'
                        ? { callId: event.callId, decision: event.decision }
                        : null
                ),
            [
                {
                    callId: 'denied-call',
                    decision: { decision: 'deny', reason: 'outside_workspace' },
                },
                {
                    callId: 'execution-call',
                    decision: { decision: 'allow' },
                },
            ]
        )
        assert.deepEqual(session.events.at(-1), {
            type: 'run_finished',
            status: 'completed',
            reason: 'final_answer',
        })
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('normalizes an unexpected dispatcher rejection into one completed result', async () => {
    let requestCount = 0
    const transport: ModelTransport = async () => {
        requestCount += 1

        if (requestCount === 1) {
            return {
                type: 'tool_calls',
                model: 'faux-model',
                toolCalls: [
                    {
                        id: 'rejected-dispatch',
                        name: 'read_file',
                        arguments: { path: 'src/agent.ts' },
                    },
                ],
            }
        }

        return {
            type: 'final_answer',
            model: 'faux-model',
            content: 'The dispatcher failed before returning evidence.',
        }
    }

    const session = await runAgentWithDispatcher(
        {
            task: 'Inspect the runtime.',
            workspaceRoot: '/approved/workspace',
            budget,
            model: 'faux-model',
            transport,
        },
        async () => {
            throw new Error('controlled dispatcher failure')
        }
    )

    assert.equal(toolResultCount(session, 'rejected-dispatch'), 1)
    assert.equal(toolCompletedCount(session, 'rejected-dispatch'), 1)
    assert.deepEqual(session.messages.at(-2), {
        role: 'tool',
        result: {
            status: 'execution_error',
            callId: 'rejected-dispatch',
            content: 'Tool dispatch failed: controlled dispatcher failure',
            metadata: {
                truncated: false,
                truncation: null,
            },
            error: {
                code: 'execution_error',
                message: 'Tool dispatch failed: controlled dispatcher failure',
            },
        },
    })
})

test('returns a failed session when the model transport rejects', async () => {
    const session = await runAgent({
        task: 'Inspect the workspace.',
        workspaceRoot: '/approved/workspace',
        budget,
        model: 'faux-model',
        transport: async () => {
            throw new Error('transport unavailable')
        },
    })

    assert.equal(session.status, 'failed')
    assert.equal(session.stepCount, 1)
    assert.equal(session.finalAnswer, null)
    assert.equal(session.stopReason, 'transport_error')
    assert.deepEqual(session.events, [
        {
            type: 'run_started',
            task: 'Inspect the workspace.',
            workspaceRoot: '/approved/workspace',
            budget,
        },
        {
            type: 'model_requested',
            step: 1,
            metadata: {
                model: 'faux-model',
                visibleTools: ['list_files', 'search_code', 'read_file'],
            },
        },
        {
            type: 'run_finished',
            status: 'failed',
            reason: 'transport_error',
        },
    ])
})
