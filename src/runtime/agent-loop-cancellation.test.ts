import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'

import { runAgent, runAgentWithDispatcher, type RunAgentOptions } from './agent-loop.ts'
import { createConversation, runConversationTurn } from './conversation.ts'
import type { ModelResponse, ModelTransportOptions, RunEventSnapshot, SessionState } from './run.ts'
import type { PatchDispatchOptions } from './tool-dispatcher.ts'
import type { ToolCall, ToolResult } from './tools.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

const answer: ModelResponse = { type: 'final_answer', model: 'faux', content: 'Done.' }
const call = (id: string): ToolCall => ({ id, name: 'read_file', arguments: { path: 'entry.ts' } })
const success = (id: string): ToolResult => ({
    status: 'success',
    callId: id,
    content: 'confirmed contents',
    metadata: { truncated: false, truncation: null },
})
const stopped = (id: string, status: 'timeout' | 'aborted'): ToolResult => ({
    status,
    callId: id,
    content: 'Stopped safely',
    metadata: { truncated: false, truncation: null },
    error: { code: status, message: 'Stopped safely' },
})
const options = (overrides: Partial<RunAgentOptions> = {}): RunAgentOptions => ({
    task: 'Inspect entry.',
    workspaceRoot: '/approved/workspace',
    model: 'faux',
    budget: { maxSteps: 3, perToolTimeoutMs: 1_000 },
    transport: async () => answer,
    ...overrides,
})
const toolResults = (session: SessionState): ToolResult[] =>
    session.messages.flatMap((message) => (message.role === 'tool' ? [message.result] : []))
const assertCancelled = (session: SessionState): void => {
    assert.equal(session.status, 'aborted')
    assert.equal(session.stopReason, 'aborted')
    assert.equal(session.finalAnswer, null)
    assert.equal(session.events.filter((event) => event.type === 'run_finished').length, 1)
    assert.equal(
        session.events.filter((event) => event.type === 'run_cancellation_requested').length,
        1
    )
}

test('nonclonable invalid arguments still receive their schema result and terminal evidence', async () => {
    let requests = 0
    const observed: RunEventSnapshot[] = []
    const session = await runAgent(
        options({
            signal: new AbortController().signal,
            transport: async () => {
                requests += 1
                return requests === 1
                    ? {
                          type: 'tool_calls',
                          model: 'faux',
                          toolCalls: [
                              {
                                  id: 'invalid',
                                  name: 'read_file',
                                  arguments: () => 'invalid',
                              },
                          ],
                      }
                    : answer
            },
            onEvent: (event) => observed.push(event),
        })
    )
    assert.equal(session.status, 'completed')
    assert.equal(toolResults(session)[0]?.status, 'invalid_arguments')
    assert.equal(session.events.filter((event) => event.type === 'tool_completed').length, 1)
    assert.equal(observed.at(-1)?.type, 'run_finished')
})

test('pre-abort and initial observer interrupts retain start and task without model work', async (t) => {
    for (const boundary of ['pre-abort', 'run_started', 'model_requested'] as const) {
        await t.test(boundary, async () => {
            const controller = new AbortController()
            const observed: RunEventSnapshot[] = []
            let requests = 0
            if (boundary === 'pre-abort') controller.abort('private reason')
            const session = await runAgent(
                options({
                    signal: controller.signal,
                    transport: async () => {
                        requests += 1
                        return answer
                    },
                    onEvent: (event) => {
                        observed.push(event)
                        if (event.type === boundary) controller.abort()
                        if (event.type === 'run_cancellation_requested') {
                            assert.ok(Object.isFrozen(event))
                            controller.abort()
                            throw new Error('observer failure')
                        }
                    },
                })
            )
            assertCancelled(session)
            assert.equal(requests, 0)
            assert.equal(session.stepCount, boundary === 'model_requested' ? 1 : 0)
            assert.deepEqual(observed, session.events)
            assert.equal(session.events[0]?.type, 'run_started')
            assert.deepEqual(session.messages.at(-1), { role: 'user', content: 'Inspect entry.' })
            assert.equal(JSON.stringify(session).includes('private reason'), false)
        })
    }
})

test('cancelled model work settles before discarding its late answer, calls, or rejection', async (t) => {
    const batch: ModelResponse = { type: 'tool_calls', model: 'faux', toolCalls: [call('late')] }
    for (const outcome of [answer, batch, 'rejection'] as const) {
        await t.test(typeof outcome === 'string' ? outcome : outcome.type, async () => {
            const controller = new AbortController()
            const started = Promise.withResolvers<void>()
            const held = Promise.withResolvers<ModelResponse>()
            let settled = false
            let transportOptions: ModelTransportOptions | undefined
            const pending = runAgentWithDispatcher(
                options({
                    signal: controller.signal,
                    transport: async (_, suppliedOptions) => {
                        transportOptions = suppliedOptions
                        started.resolve()
                        return held.promise
                    },
                }),
                async () => assert.fail('Late response must not dispatch')
            ).then((session) => {
                settled = true
                return session
            })
            await started.promise
            assert.equal(transportOptions?.signal, controller.signal)
            transportOptions?.onFinalAnswerDelta?.('Confirmed partial text.')
            controller.abort()
            transportOptions?.onFinalAnswerDelta?.('Private late text')
            await setImmediate()
            assert.equal(settled, false)
            if (outcome === 'rejection') held.reject(new Error('private transport failure'))
            else held.resolve(outcome)
            const session = await pending
            assertCancelled(session)
            assert.equal(session.messages.length, 2)
            assert.deepEqual(
                session.events.map((event) => event.type),
                [
                    'run_started',
                    'model_requested',
                    'final_answer_delta',
                    'run_cancellation_requested',
                    'run_finished',
                ]
            )
            const snapshot = structuredClone(session)
            transportOptions?.onFinalAnswerDelta?.('Stale text after settlement')
            assert.deepEqual(session, snapshot)
        })
    }
})

test('accepted batch cancellation from response or requested-call observers accounts for every ID', async (t) => {
    for (const boundary of ['model_responded', 'tool_requested'] as const) {
        await t.test(boundary, async () => {
            const controller = new AbortController()
            const calls = [call('first'), call('second'), call('third')] as const
            const observed: RunEventSnapshot[] = []
            const session = await runAgentWithDispatcher(
                options({
                    signal: controller.signal,
                    budget: { maxSteps: 1, perToolTimeoutMs: 1_000 },
                    transport: async () => ({
                        type: 'tool_calls',
                        model: 'faux',
                        toolCalls: calls,
                    }),
                    onEvent: (event) => {
                        observed.push(event)
                        if (event.type === boundary) controller.abort()
                    },
                }),
                async () => assert.fail('Unstarted calls must not dispatch or authorize')
            )
            assertCancelled(session)
            assert.deepEqual(observed, session.events)
            assert.equal(session.messages[2]?.role, 'assistant')
            assert.deepEqual(
                toolResults(session).map((result) => [result.callId, result.status]),
                [
                    ['first', 'aborted'],
                    ['second', 'aborted'],
                    ['third', 'aborted'],
                ]
            )
            assert.deepEqual(
                session.events.flatMap((event) => {
                    if (event.type === 'tool_requested') return [`requested:${event.call.id}`]
                    if (event.type === 'tool_completed') return [`completed:${event.result.callId}`]
                    return []
                }),
                [
                    'requested:first',
                    'completed:first',
                    'requested:second',
                    'completed:second',
                    'requested:third',
                    'completed:third',
                ]
            )
            assert.equal(
                session.events.some((event) => event.type === 'tool_authorized'),
                false
            )
        })
    }
})

test('mixed accepted calls retain active timeout, abort, or committed success after held cleanup', async (t) => {
    for (const activeStatus of ['timeout', 'aborted', 'success'] as const) {
        await t.test(activeStatus, async () => {
            const controller = new AbortController()
            const started = Promise.withResolvers<void>()
            const cleanup = Promise.withResolvers<void>()
            const dispatched: string[] = []
            let requests = 0
            let settled = false
            let stalePermission: (() => void) | undefined
            let staleLifecycle: PatchDispatchOptions['onLifecycleEvent']
            const pending = runAgentWithDispatcher(
                options({
                    signal: controller.signal,
                    budget: { maxSteps: 1, perToolTimeoutMs: 1_000 },
                    transport: async () => {
                        requests += 1
                        return {
                            type: 'tool_calls',
                            model: 'faux',
                            toolCalls: [call('first'), call('active'), call('skipped')],
                        }
                    },
                }),
                async (_, requested, __, permission, patchOptions, executionOptions) => {
                    dispatched.push(requested.id)
                    assert.equal(executionOptions?.signal, controller.signal)
                    permission?.({ decision: 'allow' })
                    if (requested.id === 'first') return success(requested.id)
                    stalePermission = () => permission?.({ decision: 'allow' })
                    staleLifecycle = patchOptions?.onLifecycleEvent
                    started.resolve()
                    await cleanup.promise
                    return activeStatus === 'success'
                        ? success(requested.id)
                        : stopped(requested.id, activeStatus)
                }
            ).then((session) => {
                settled = true
                return session
            })
            await started.promise
            controller.abort()
            controller.abort()
            await setImmediate()
            assert.equal(settled, false)
            assert.deepEqual(dispatched, ['first', 'active'])
            cleanup.resolve()
            const session = await pending
            assertCancelled(session)
            assert.equal(requests, 1)
            assert.deepEqual(
                toolResults(session).map((result) => [result.callId, result.status]),
                [
                    ['first', 'success'],
                    ['active', activeStatus],
                    ['skipped', 'aborted'],
                ]
            )
            assert.equal(
                session.events.filter((event) => event.type === 'tool_completed').length,
                3
            )
            assert.equal(
                session.events.filter((event) => event.type === 'tool_authorized').length,
                2
            )
            const snapshot = structuredClone(session)
            stalePermission?.()
            staleLifecycle?.({
                type: 'applied',
                metadata: {
                    proposalId: 'stale',
                    relativePath: 'entry.ts',
                    baseHash: 'base',
                    nextHash: 'next',
                    addedLineCount: 1,
                    removedLineCount: 1,
                },
            })
            assert.deepEqual(session, snapshot)
        })
    }
})

test('final response observer cancellation precedes commit and suppresses the final answer', async () => {
    const controller = new AbortController()
    const session = await runAgent(
        options({
            signal: controller.signal,
            onEvent: (event) => {
                if (event.type === 'model_responded') controller.abort()
            },
        })
    )
    assertCancelled(session)
    assert.equal(session.messages.length, 2)
    assert.equal(
        session.events.some((event) => event.type === 'final_answer'),
        false
    )
})

test('terminal answer and finish observers cannot relabel committed completion', async (t) => {
    for (const boundary of ['final_answer', 'run_finished'] as const) {
        await t.test(boundary, async () => {
            const controller = new AbortController()
            let staleDelta: ModelTransportOptions['onFinalAnswerDelta']
            const session = await runAgent(
                options({
                    signal: controller.signal,
                    transport: async (_, transportOptions) => {
                        staleDelta = transportOptions?.onFinalAnswerDelta
                        return answer
                    },
                    onEvent: (event) => {
                        if (event.type === boundary) {
                            controller.abort()
                            staleDelta?.('Must not appear')
                            throw new Error('observer failed')
                        }
                    },
                })
            )
            assert.equal(session.status, 'completed')
            assert.equal(session.stopReason, 'final_answer')
            assert.equal(session.finalAnswer, 'Done.')
            assert.equal(
                session.events.some((event) => event.type === 'run_cancellation_requested'),
                false
            )
            assert.equal(
                session.events.some((event) => event.type === 'final_answer_delta'),
                false
            )
        })
    }
})

test('old step answer callbacks close before dispatch and the next model request without a signal', async () => {
    let previousDelta: ModelTransportOptions['onFinalAnswerDelta']
    let requests = 0
    const session = await runAgentWithDispatcher(
        options({
            transport: async (_, transportOptions) => {
                requests += 1
                if (requests === 1) {
                    previousDelta = transportOptions?.onFinalAnswerDelta
                    return { type: 'tool_calls', model: 'faux', toolCalls: [call('read')] }
                }
                previousDelta?.('Old step leak')
                transportOptions?.onFinalAnswerDelta?.('Done.')
                return answer
            },
        }),
        async () => {
            previousDelta?.('Tool phase leak')
            return success('read')
        }
    )
    assert.deepEqual(
        session.events
            .filter((event) => event.type === 'final_answer_delta')
            .map((event) => event.delta),
        ['Done.']
    )
    previousDelta?.('Settled leak')
    assert.equal(session.events.filter((event) => event.type === 'final_answer_delta').length, 1)
})

test('observer cancellation from a confirmed delta retains partial output but prevents final completion', async () => {
    const controller = new AbortController()
    const session = await runAgent(
        options({
            signal: controller.signal,
            transport: async (_, transportOptions) => {
                transportOptions?.onFinalAnswerDelta?.('Confirmed.')
                transportOptions?.onFinalAnswerDelta?.('Late.')
                return answer
            },
            onEvent: (event) => {
                if (event.type === 'final_answer_delta') controller.abort()
            },
        })
    )
    assertCancelled(session)
    assert.deepEqual(
        session.events
            .filter((event) => event.type === 'final_answer_delta')
            .map((event) => event.delta),
        ['Confirmed.']
    )
})

test('applied patch survives cancellation from its lifecycle observer with no further calls', async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'yo-loop-cancel-patch-'))
    t.after(() => rm(fixture, { recursive: true, force: true }))
    const workspaceRoot = await canonicalizeWorkspaceRoot(fixture)
    const source = join(workspaceRoot, 'entry.ts')
    await writeFile(source, 'export const value = 1\n')
    const controller = new AbortController()
    const session = await runAgent(
        options({
            workspaceRoot,
            signal: controller.signal,
            patchApprover: async () => 'approved',
            transport: async () => ({
                type: 'tool_calls',
                model: 'faux',
                toolCalls: [
                    {
                        id: 'patch',
                        name: 'propose_patch',
                        arguments: {
                            path: 'entry.ts',
                            edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
                        },
                    },
                    call('skipped'),
                ],
            }),
            onEvent: (event) => {
                if (event.type === 'patch_applied') controller.abort()
            },
        })
    )
    assertCancelled(session)
    assert.equal(await readFile(source, 'utf8'), 'export const value = 2\n')
    assert.deepEqual(
        toolResults(session).map((result) => [result.callId, result.status]),
        [
            ['patch', 'success'],
            ['skipped', 'aborted'],
        ]
    )
    assert.equal(session.events.filter((event) => event.type === 'patch_applied').length, 1)
})

test('approval-only abort continues the loop and remains local to its patch', async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'yo-loop-review-abort-'))
    t.after(() => rm(fixture, { recursive: true, force: true }))
    const workspaceRoot = await canonicalizeWorkspaceRoot(fixture)
    const source = join(workspaceRoot, 'entry.ts')
    await writeFile(source, 'export const value = 1\n')
    let requests = 0
    const session = await runAgent(
        options({
            workspaceRoot,
            signal: new AbortController().signal,
            patchApprover: async () => 'aborted',
            transport: async () => {
                requests += 1
                return requests === 1
                    ? {
                          type: 'tool_calls',
                          model: 'faux',
                          toolCalls: [
                              {
                                  id: 'patch',
                                  name: 'propose_patch',
                                  arguments: {
                                      path: 'entry.ts',
                                      edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
                                  },
                              },
                          ],
                      }
                    : answer
            },
        })
    )
    assert.equal(session.status, 'completed')
    assert.equal(requests, 2)
    assert.equal(toolResults(session)[0]?.status, 'aborted')
    assert.equal(
        session.events.some((event) => event.type === 'run_cancellation_requested'),
        false
    )
    assert.equal(await readFile(source, 'utf8'), 'export const value = 1\n')
})

test('cancelled conversation retains its accepted suffix once and a fresh turn rejects stale callbacks', async () => {
    const conversation = createConversation({ workspaceRoot: '/approved/workspace', model: 'faux' })
    const controller = new AbortController()
    let oldDelta: ModelTransportOptions['onFinalAnswerDelta']
    const first = await runConversationTurn({
        conversation,
        task: 'First task',
        budget: { maxSteps: 1, perToolTimeoutMs: 1_000 },
        signal: controller.signal,
        transport: async (_, transportOptions) => {
            assert.equal(transportOptions?.signal, controller.signal)
            oldDelta = transportOptions?.onFinalAnswerDelta
            return { type: 'tool_calls', model: 'faux', toolCalls: [call('skipped')] }
        },
        onEvent: (event) => {
            if (event.type === 'model_responded') controller.abort()
        },
    })
    assertCancelled(first.turn.session)
    assert.equal(first.turn.messages.length, 3)
    assert.equal(conversation.messages.length, 1)
    const oldSession = structuredClone(first.turn.session)
    const second = await runConversationTurn({
        conversation: first.conversation,
        task: 'Second task',
        budget: { maxSteps: 1, perToolTimeoutMs: 1_000 },
        transport: async (request) => {
            oldDelta?.('Stale first turn')
            assert.deepEqual(request.messages.slice(0, -1), first.conversation.messages)
            return answer
        },
    })
    assert.equal(second.turn.session.status, 'completed')
    assert.equal(second.turn.session.stepCount, 1)
    assert.deepEqual(
        second.conversation.messages.map((message) => message.role),
        ['system', 'user', 'assistant', 'tool', 'user', 'assistant']
    )
    assert.equal(
        second.conversation.messages.filter(
            (message) => message.role === 'user' && message.content === 'First task'
        ).length,
        1
    )
    assert.deepEqual(first.turn.session, oldSession)
    assert.equal(
        second.turn.session.events.some((event) => event.type === 'final_answer_delta'),
        false
    )
})
