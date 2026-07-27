import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createRunEventSnapshot, runAgent, runAgentWithDispatcher } from './agent-loop.ts'
import type {
    ModelRequest,
    ModelTransport,
    RunEvent,
    RunEventSnapshot,
    SessionState,
} from './run.ts'
import type { ToolCall, ToolResult } from './tools.ts'
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

test('delivers detached read-only events after recording them', async () => {
    const observed: RunEventSnapshot[] = []
    let eventsAtFirstObservation = -1
    const transport: ModelTransport = async () => ({
        type: 'final_answer',
        model: 'faux-model',
        content: 'Done.',
    })

    const session = await runAgent({
        task: 'Finish.',
        workspaceRoot: '/approved/workspace',
        budget,
        model: 'faux-model',
        transport,
        onEvent: (event) => {
            observed.push(event)

            if (event.type === 'run_started') {
                eventsAtFirstObservation = observed.length
            }
        },
    })

    assert.equal(eventsAtFirstObservation, 1)
    assert.deepEqual(observed, session.events)
    assert.notEqual(observed[0], session.events[0])
    assert.ok(Object.isFrozen(observed[0]))
    assert.ok(Object.isFrozen(observed[1]?.type === 'model_requested' ? observed[1].metadata : {}))
})

test('creates detached frozen snapshots for safe patch lifecycle metadata', () => {
    const event: RunEvent = {
        type: 'patch_approval_resolved',
        step: 1,
        callId: 'patch-call',
        metadata: {
            proposalId: 'proposal-1',
            relativePath: 'src/example.ts',
            baseHash: 'base-hash',
            nextHash: 'next-hash',
            addedLineCount: 1,
            removedLineCount: 1,
        },
        decision: 'approved',
    }

    const snapshot = createRunEventSnapshot(event)
    if (snapshot.type !== 'patch_approval_resolved') {
        throw new Error('Expected patch approval event snapshot')
    }

    assert.notEqual(snapshot, event)
    assert.notEqual(snapshot.metadata, event.metadata)
    assert.ok(Object.isFrozen(snapshot))
    assert.ok(Object.isFrozen(snapshot.metadata))
    assert.equal('diff' in snapshot.metadata, false)
    assert.equal('nextContent' in snapshot.metadata, false)
    assert.throws(() => {
        ;(snapshot.metadata as { relativePath: string }).relativePath = 'mutated.ts'
    }, TypeError)
    assert.equal(event.metadata.relativePath, 'src/example.ts')
})

test('isolates nested observer snapshots from runtime events and transcript', async () => {
    const call = {
        id: 'read-call',
        name: 'read_file',
        arguments: { path: 'src/agent.ts' },
    }
    let observedCall: Extract<RunEventSnapshot, { type: 'tool_requested' }> | undefined
    let observedResult: Extract<RunEventSnapshot, { type: 'tool_completed' }> | undefined
    const transport: ModelTransport = async (request) =>
        request.messages.some((message) => message.role === 'tool')
            ? {
                  type: 'final_answer',
                  model: 'faux-model',
                  content: 'Done.',
              }
            : {
                  type: 'tool_calls',
                  model: 'faux-model',
                  toolCalls: [call],
              }

    const session = await runAgentWithDispatcher(
        {
            task: 'Read the file.',
            workspaceRoot: '/approved/workspace',
            budget,
            model: 'faux-model',
            transport,
            onEvent: (event) => {
                if (event.type === 'tool_requested') {
                    observedCall = event
                }

                if (event.type === 'tool_completed') {
                    observedResult = event
                }
            },
        },
        async () => ({
            status: 'success',
            callId: call.id,
            content: 'contents',
            metadata: { truncated: false, truncation: null },
        })
    )

    assert.ok(observedCall)
    assert.ok(observedResult)
    const requested = session.events.find((event) => event.type === 'tool_requested')
    const completed = session.events.find((event) => event.type === 'tool_completed')
    const transcriptResult = session.messages.find((message) => message.role === 'tool')

    assert.ok(requested?.type === 'tool_requested')
    assert.ok(completed?.type === 'tool_completed')
    assert.ok(transcriptResult?.role === 'tool')
    assert.notEqual(observedCall.call, requested.call)
    assert.notEqual(observedCall.call.arguments, requested.call.arguments)
    assert.notEqual(observedResult.result, completed.result)
    assert.notEqual(observedResult.result, transcriptResult.result)
    assert.throws(() => {
        ;(observedCall!.call.arguments as { path: string }).path = 'mutated.ts'
    }, TypeError)
    assert.equal((requested.call.arguments as { path: string }).path, 'src/agent.ts')
})

test('swallows observer errors without changing the completed run', async () => {
    let notifications = 0
    const transport: ModelTransport = async (_request, options) => {
        options?.onFinalAnswerDelta?.('Done.')

        return {
            type: 'final_answer',
            model: 'faux-model',
            content: 'Done.',
        }
    }

    const session = await runAgent({
        task: 'Finish.',
        workspaceRoot: '/approved/workspace',
        budget,
        model: 'faux-model',
        transport,
        onEvent: () => {
            notifications += 1
            throw new Error('renderer failure')
        },
    })

    assert.equal(notifications, session.events.length)
    assert.equal(session.status, 'completed')
    assert.equal(session.finalAnswer, 'Done.')
    assert.equal(session.messages.filter((message) => message.role === 'assistant').length, 1)
    assert.equal(session.events.filter((event) => event.type === 'final_answer_delta').length, 1)
})

test('records confirmed answer deltas before the completed model response', async () => {
    const observed: RunEventSnapshot[] = []
    const transport: ModelTransport = async (_request, options) => {
        options?.onFinalAnswerDelta?.('Grounded ')
        options?.onFinalAnswerDelta?.('answer.')

        return {
            type: 'final_answer',
            model: 'faux-model',
            content: 'Grounded answer.',
        }
    }

    const session = await runAgent({
        task: 'Finish.',
        workspaceRoot: '/approved/workspace',
        budget,
        model: 'faux-model',
        transport,
        onEvent: (event) => observed.push(event),
    })

    assert.deepEqual(observed, session.events)
    assert.deepEqual(
        session.events.map((event) => event.type),
        [
            'run_started',
            'model_requested',
            'final_answer_delta',
            'final_answer_delta',
            'model_responded',
            'final_answer',
            'run_finished',
        ]
    )
    assert.deepEqual(
        session.events
            .filter((event) => event.type === 'final_answer_delta')
            .map((event) => event.delta),
        ['Grounded ', 'answer.']
    )
})

test('records and notifies each tool outcome exactly once in lifecycle order', async () => {
    const calls: readonly [ToolCall, ...ToolCall[]] = [
        { id: 'success-call', name: 'read_file', arguments: { path: 'success.ts' } },
        { id: 'invalid-call', name: 'read_file', arguments: { path: 1 } },
        { id: 'denied-call', name: 'read_file', arguments: { path: 'denied.ts' } },
        { id: 'timeout-call', name: 'read_file', arguments: { path: 'timeout.ts' } },
        { id: 'error-call', name: 'read_file', arguments: { path: 'error.ts' } },
    ]
    const observed: RunEventSnapshot[] = []
    let requestCount = 0
    const transport: ModelTransport = async () => {
        requestCount += 1

        return requestCount === 1
            ? { type: 'tool_calls', model: 'faux-model', toolCalls: calls }
            : { type: 'final_answer', model: 'faux-model', content: 'Done.' }
    }

    const session = await runAgentWithDispatcher(
        {
            task: 'Exercise every outcome.',
            workspaceRoot: '/approved/workspace',
            budget,
            model: 'faux-model',
            transport,
            onEvent: (event) => observed.push(event),
        },
        async (_workspaceRoot, call, _timeoutMs, onPermissionDecision) => {
            const resultByCallId: Record<string, ToolResult> = {
                'success-call': {
                    status: 'success',
                    callId: call.id,
                    content: 'contents',
                    metadata: { truncated: false, truncation: null },
                },
                'invalid-call': {
                    status: 'invalid_arguments',
                    callId: call.id,
                    content: 'Invalid arguments',
                    metadata: { truncated: false, truncation: null },
                    error: { code: 'invalid_arguments', message: 'Invalid arguments' },
                },
                'denied-call': {
                    status: 'denied',
                    callId: call.id,
                    content: 'Denied',
                    metadata: { truncated: false, truncation: null },
                    error: { code: 'outside_workspace', message: 'Denied' },
                },
                'timeout-call': {
                    status: 'timeout',
                    callId: call.id,
                    content: 'Timed out',
                    metadata: { truncated: false, truncation: null },
                    error: { code: 'timeout', message: 'Timed out' },
                },
                'error-call': {
                    status: 'execution_error',
                    callId: call.id,
                    content: 'Failed',
                    metadata: { truncated: false, truncation: null },
                    error: { code: 'execution_error', message: 'Failed' },
                },
            }
            const result = resultByCallId[call.id]!

            if (result.status !== 'invalid_arguments') {
                onPermissionDecision?.(
                    result.status === 'denied'
                        ? { decision: 'deny', reason: 'outside_workspace' }
                        : { decision: 'allow' }
                )
            }

            return result
        }
    )

    assert.deepEqual(observed, session.events)
    assert.deepEqual(
        session.events.map((event) => event.type),
        [
            'run_started',
            'model_requested',
            'model_responded',
            'tool_requested',
            'tool_authorized',
            'tool_completed',
            'tool_requested',
            'tool_completed',
            'tool_requested',
            'tool_authorized',
            'tool_completed',
            'tool_requested',
            'tool_authorized',
            'tool_completed',
            'tool_requested',
            'tool_authorized',
            'tool_completed',
            'model_requested',
            'model_responded',
            'final_answer',
            'run_finished',
        ]
    )
    for (const call of calls) {
        assert.equal(toolResultCount(session, call.id), 1)
        assert.equal(toolCompletedCount(session, call.id), 1)
    }
})

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
    const observed: RunEventSnapshot[] = []
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
        onEvent: (event) => observed.push(event),
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
    assert.deepEqual(observed, session.events)

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
    const observed: RunEventSnapshot[] = []
    const session = await runAgent({
        task: 'Inspect the workspace.',
        workspaceRoot: '/approved/workspace',
        budget,
        model: 'faux-model',
        transport: async () => {
            throw new Error('transport unavailable')
        },
        onEvent: (event) => observed.push(event),
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
    assert.deepEqual(observed, session.events)
})

test('propagates approved sequential patch calls as safe ordered lifecycle events', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-agent-patch-approved-'))
    const workspaceRoot = await canonicalizeWorkspaceRoot(fixtureRoot)
    const sourcePath = join(workspaceRoot, 'example.ts')
    await writeFile(sourcePath, 'const first = 1\nconst second = 2\n')
    let requestCount = 0

    const session = await runAgent({
        task: 'Apply the exact updates.',
        workspaceRoot,
        budget: { maxSteps: 2, perToolTimeoutMs: 1_000 },
        model: 'faux-model',
        transport: async (request) => {
            requestCount += 1
            assert.deepEqual(request.visibleTools, ['list_files', 'search_code', 'read_file'])

            return requestCount === 1
                ? {
                      type: 'tool_calls' as const,
                      model: 'faux-model',
                      toolCalls: [
                          {
                              id: 'first-patch',
                              name: 'propose_patch',
                              arguments: {
                                  path: 'example.ts',
                                  edits: [{ oldText: 'first = 1', newText: 'first = 3' }],
                              },
                          },
                          {
                              id: 'second-patch',
                              name: 'propose_patch',
                              arguments: {
                                  path: 'example.ts',
                                  edits: [{ oldText: 'second = 2', newText: 'second = 4' }],
                              },
                          },
                      ],
                  }
                : { type: 'final_answer' as const, model: 'faux-model', content: 'Updated.' }
        },
        patchApprover: async () => 'approved',
    })

    assert.equal(await readFile(sourcePath, 'utf8'), 'const first = 3\nconst second = 4\n')
    assert.deepEqual(
        session.events.map((event) => event.type),
        [
            'run_started',
            'model_requested',
            'model_responded',
            'tool_requested',
            'tool_authorized',
            'patch_prepared',
            'patch_approval_requested',
            'patch_approval_resolved',
            'patch_applied',
            'tool_completed',
            'tool_requested',
            'tool_authorized',
            'patch_prepared',
            'patch_approval_requested',
            'patch_approval_resolved',
            'patch_applied',
            'tool_completed',
            'model_requested',
            'model_responded',
            'final_answer',
            'run_finished',
        ]
    )
    assert.equal(toolResultCount(session, 'first-patch'), 1)
    assert.equal(toolResultCount(session, 'second-patch'), 1)
    assert.equal(toolCompletedCount(session, 'first-patch'), 1)
    assert.equal(toolCompletedCount(session, 'second-patch'), 1)
    assert.ok(
        session.events
            .filter((event) => event.type === 'patch_prepared')
            .every((event) => !('diff' in event.metadata) && !('nextContent' in event.metadata))
    )
})

test('denies an unapproved patch and lets the model recover with a read-only result', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-agent-patch-denied-'))
    const workspaceRoot = await canonicalizeWorkspaceRoot(fixtureRoot)
    const sourcePath = join(workspaceRoot, 'example.ts')
    await writeFile(sourcePath, 'export const value = 1\n')
    let requestCount = 0

    const session = await runAgent({
        task: 'Try the change, then inspect it.',
        workspaceRoot,
        budget: { maxSteps: 3, perToolTimeoutMs: 1_000 },
        model: 'faux-model',
        transport: async () => {
            requestCount += 1
            if (requestCount === 1) {
                return {
                    type: 'tool_calls' as const,
                    model: 'faux-model',
                    toolCalls: [
                        {
                            id: 'denied-patch',
                            name: 'propose_patch',
                            arguments: {
                                path: 'example.ts',
                                edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
                            },
                        },
                    ],
                }
            }
            if (requestCount === 2) {
                return {
                    type: 'tool_calls' as const,
                    model: 'faux-model',
                    toolCalls: [
                        {
                            id: 'read-after-denial',
                            name: 'read_file',
                            arguments: { path: 'example.ts' },
                        },
                    ],
                }
            }

            return { type: 'final_answer' as const, model: 'faux-model', content: 'Not changed.' }
        },
    })

    assert.equal(await readFile(sourcePath, 'utf8'), 'export const value = 1\n')
    const denial = session.messages.find(
        (message) => message.role === 'tool' && message.result.callId === 'denied-patch'
    )
    assert.deepEqual(denial, {
        role: 'tool',
        result: {
            status: 'denied',
            callId: 'denied-patch',
            content: 'Patch approval denied',
            metadata: { truncated: false, truncation: null },
            error: { code: 'approval_denied', message: 'Patch approval denied' },
        },
    })
    assert.equal(session.status, 'completed')
    assert.equal(toolResultCount(session, 'denied-patch'), 1)
    assert.equal(toolCompletedCount(session, 'denied-patch'), 1)
})

test('records a conflict before a read and approved reproposal while isolating lifecycle observers', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-agent-patch-conflict-'))
    const workspaceRoot = await canonicalizeWorkspaceRoot(fixtureRoot)
    const sourcePath = join(workspaceRoot, 'example.ts')
    await writeFile(sourcePath, 'export const value = 1\n')
    let requestCount = 0
    let approvalCount = 0

    const session = await runAgent({
        task: 'Rebase the update after a conflict.',
        workspaceRoot,
        budget: { maxSteps: 4, perToolTimeoutMs: 1_000 },
        model: 'faux-model',
        transport: async () => {
            requestCount += 1
            if (requestCount === 1) {
                return {
                    type: 'tool_calls' as const,
                    model: 'faux-model',
                    toolCalls: [
                        {
                            id: 'stale-patch',
                            name: 'propose_patch',
                            arguments: {
                                path: 'example.ts',
                                edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
                            },
                        },
                    ],
                }
            }
            if (requestCount === 2) {
                return {
                    type: 'tool_calls' as const,
                    model: 'faux-model',
                    toolCalls: [
                        {
                            id: 'read-after-conflict',
                            name: 'read_file',
                            arguments: { path: 'example.ts' },
                        },
                    ],
                }
            }
            if (requestCount === 3) {
                return {
                    type: 'tool_calls' as const,
                    model: 'faux-model',
                    toolCalls: [
                        {
                            id: 'rebased-patch',
                            name: 'propose_patch',
                            arguments: {
                                path: 'example.ts',
                                edits: [{ oldText: 'value = 3', newText: 'value = 4' }],
                            },
                        },
                    ],
                }
            }

            return { type: 'final_answer' as const, model: 'faux-model', content: 'Rebased.' }
        },
        patchApprover: async () => {
            approvalCount += 1
            if (approvalCount === 1) {
                await writeFile(sourcePath, 'export const value = 3\n')
            }

            return 'approved'
        },
        onEvent: (event) => {
            if (event.type.startsWith('patch_')) {
                throw new Error('observer failure')
            }
        },
    })

    assert.equal(await readFile(sourcePath, 'utf8'), 'export const value = 4\n')
    assert.equal(session.status, 'completed')
    assert.ok(session.events.some((event) => event.type === 'patch_conflicted'))
    assert.ok(session.events.some((event) => event.type === 'patch_applied'))
    assert.equal(toolResultCount(session, 'stale-patch'), 1)
    assert.equal(toolCompletedCount(session, 'stale-patch'), 1)
})
