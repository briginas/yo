import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runCli, type CliDependencies } from './cli-app.ts'
import type { ChatSubmission } from './line-input.ts'
import { projectRunEvent } from './run-observation.ts'
import {
    runConversationTurn,
    type RunConversationTurnOptions,
    type RunConversationTurnResult,
} from './runtime/conversation.ts'
import type { ModelRequest, RunEventObserver } from './runtime/run.ts'

type Failure =
    'none' | 'rendering' | 'projection' | 'observer' | 'answer_fallback' | 'clock' | 'diagnostic'
type Phase = 'idle' | 'acceptance' | 'events' | 'settlement'
const sourceTask = ` \tExact 🧩 ${'long source '.repeat(30)} end  `
const correction = 'Use the current correction.'

const execute = async (workspace: string, failure: Failure, stream = failure === 'observer') => {
    const submissions: ChatSubmission[] = [
        { line: sourceTask, windowId: 1 },
        { line: '/run 1', windowId: 2 },
        { line: correction, windowId: 3 },
        { line: ' \t/rerun\t1 ', windowId: 7 },
        { line: '/rerun 1', windowId: 7 },
        { line: '/run 1', windowId: 8 },
        { line: '/run 3', windowId: 8 },
        { line: '/run 1', windowId: 8 },
        { line: '/run 3', windowId: 8 },
        { line: '/rerun 1', windowId: 9 },
        { line: '/rerun 1', windowId: 9 },
        { line: '/rerun 3', windowId: 10 },
        { line: '/runs', windowId: 11 },
        { line: '/exit', windowId: 12 },
    ]
    const requests: ModelRequest[] = []
    const invocations: RunConversationTurnOptions[] = []
    const results: RunConversationTurnResult[] = []
    const observers: RunEventObserver[] = []
    const output: string[] = [],
        statuses: string[] = [],
        answers: string[] = [],
        diagnostics: string[] = []
    const failures: Phase[] = []
    let phase: Phase = 'idle',
        reads = 0,
        samples = 0
    const inject = (): never => {
        failures.push(phase)
        throw new Error('Bearer private injected failure')
    }
    const lateCallbacks = (): void => {
        const before = [samples, output.length, statuses.length, answers.length, diagnostics.length]
        for (const observer of [observers[0], observers[2]]) {
            assert.ok(observer)
            observer({ type: 'run_cancellation_requested' })
            observer({ type: 'final_answer_delta', delta: 'LATE private answer' })
            observer({ type: 'run_finished', status: 'aborted', reason: 'aborted' })
        }
        assert.deepEqual(
            [samples, output.length, statuses.length, answers.length, diagnostics.length],
            before
        )
    }
    const dependencies: CliDependencies = {
        createLineInput: () => ({
            readLine: async () => {
                throw new Error('Unexpected approval input')
            },
            readChatSubmission: async () => {
                phase = 'idle'
                // The first source callback arrives while its accepted rerun is active;
                // this second delivery targets both records after their settlement.
                if (reads === 7) lateCallbacks()
                const next = submissions[reads++] ?? null
                if (reads === 4) phase = 'acceptance'
                return next
            },
            close: () => undefined,
        }),
        runTurn: async (options) => {
            const turn = invocations.length + 1
            assert.equal(options.signal?.aborted, false)
            invocations.push(options)
            assert.ok(options.onEvent)
            observers.push(options.onEvent)
            if (turn === 3) {
                phase = 'events'
                observers[0]!({ type: 'run_cancellation_requested' })
                observers[0]!({ type: 'final_answer_delta', delta: 'LATE private answer' })
            }
            const result = await runConversationTurn(options)
            results.push(structuredClone(result))
            if (turn === 3) phase = 'settlement'
            return result
        },
        transport: async (request, options) => {
            requests.push(structuredClone(request))
            const turn = invocations.length
            if (request.messages.at(-1)?.role === 'user') {
                return {
                    type: 'tool_calls',
                    model: null,
                    toolCalls: [
                        { id: `list-${turn}`, name: 'list_files', arguments: { path: '.' } },
                    ],
                }
            }
            if (turn === 3 && stream) options?.onFinalAnswerDelta?.(`Answer ${turn}`)
            return { type: 'final_answer', model: null, content: `Answer ${turn}` }
        },
        observationProjectEvent: (record, id, event, time) => {
            if (phase === 'events' && (failure === 'projection' || failure === 'diagnostic'))
                inject()
            return projectRunEvent(record, id, event, time)
        },
        observationClocks: {
            wallTime: () => {
                samples++
                if (phase !== 'idle' && (failure === 'clock' || failure === 'diagnostic')) inject()
                return 1000 + samples
            },
            monotonicTime: () => 100 + samples,
        },
        writeStatus: (text) => {
            if ((phase === 'acceptance' || phase === 'events') && failure === 'rendering') inject()
            statuses.push(text)
        },
        writeAnswer: (text) => {
            if (
                (phase === 'events' && failure === 'observer') ||
                (phase === 'settlement' && failure === 'answer_fallback')
            )
                inject()
            answers.push(text)
        },
        writeOutput: (text) => {
            if (phase === 'settlement' && failure === 'rendering') inject()
            output.push(text)
        },
        writeError: (text) => {
            diagnostics.push(text)
            if (phase !== 'idle' && failure === 'diagnostic') inject()
        },
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        subscribeProcessInterrupt: () => () => undefined,
        isInteractive: false,
    }
    const result = await runCli(['--cwd', workspace], dependencies)
    return {
        result,
        requests,
        invocations,
        results,
        output,
        statuses,
        answers,
        diagnostics,
        failures,
    }
}

test('rerun display failures cannot change receipts, execution, source evidence or settled callbacks', async (context) => {
    const workspace = await mkdtemp(join(tmpdir(), 'yo-rerun-observation-'))
    try {
        const control = await execute(workspace, 'none')
        for (const failure of [
            'rendering',
            'projection',
            'observer',
            'answer_fallback',
            'clock',
            'diagnostic',
        ] as const) {
            await context.test(failure, async () => {
                const expected =
                    failure === 'observer' ? await execute(workspace, 'none', true) : control
                const state = await execute(workspace, failure)
                assert.equal(state.result.exitCode, 0)
                assert.equal(state.invocations.length, 5)
                assert.equal(state.requests.length, 10)
                assert.deepEqual(state.requests, expected.requests)
                assert.deepEqual(state.results, expected.results)
                assert.deepEqual(state.result.session, expected.result.session)
                assert.deepEqual(state.invocations[2]?.conversation, state.results[1]?.conversation)
                assert.deepEqual(
                    state.requests[4]?.messages.filter((message) => message.role === 'user'),
                    [
                        { role: 'user', content: sourceTask },
                        { role: 'user', content: correction },
                        { role: 'user', content: sourceTask },
                    ]
                )
                assert.deepEqual(
                    state.invocations.map((item) => item.task),
                    [sourceTask, correction, sourceTask, sourceTask, sourceTask]
                )
                for (const invocation of state.invocations) {
                    assert.deepEqual(invocation.budget, { maxSteps: 10, perToolTimeoutMs: 5000 })
                    assert.equal(invocation.signal?.aborted, false)
                }
                assert.equal(new Set(state.invocations.map((item) => item.signal)).size, 5)
                assert.deepEqual(
                    state.output.filter((text) => text.startsWith('Rerun action')),
                    [
                        'Rerun action already accepted as Run #3.',
                        'Rerun action already accepted as Run #4.',
                    ]
                )
                const sourceViews = state.output.filter((text) => text.startsWith('Run #1:'))
                const rerunViews = state.output.filter((text) => text.startsWith('Run #3:'))
                assert.equal(sourceViews.length, 3)
                assert.equal(sourceViews[0], sourceViews[1])
                assert.equal(sourceViews[0], sourceViews[2])
                assert.equal(
                    sourceViews[0],
                    control.output.find((text) => text.startsWith('Run #1:'))
                )
                assert.equal(rerunViews.length, 2)
                assert.equal(rerunViews[0], rerunViews[1])
                assert.match(rerunViews[0]!, /Run #3 result: completed/)
                assert.match(rerunViews[0]!, /Rerun of #1.*Context: current conversation/)
                assert.match(rerunViews[0]!, /Retained answer:\nAnswer 3/)
                const list = state.output.at(-1)!
                assert.match(list, /- #4 .*completed.*Rerun of #1/)
                assert.match(list, /- #5 .*completed.*Rerun of #3/)
                assert.doesNotMatch(list, /#6/)
                assert.ok(state.failures.length > 0)
                if (failure === 'rendering' || failure === 'clock' || failure === 'diagnostic') {
                    assert.ok(state.failures.includes('acceptance'))
                    assert.ok(state.failures.includes('events'))
                    assert.ok(state.failures.includes('settlement'))
                } else
                    assert.ok(
                        state.failures.includes(
                            failure === 'answer_fallback' ? 'settlement' : 'events'
                        )
                    )
                assert.ok(state.diagnostics.length > 0)
                const diagnostic =
                    failure === 'rendering'
                        ? 'display failed'
                        : failure === 'projection'
                          ? 'event projection failed'
                          : failure === 'observer' || failure === 'answer_fallback'
                            ? 'answer observer failed'
                            : 'timing sample unavailable'
                assert.ok(state.diagnostics.some((text) => text.includes(diagnostic)))
                if (failure === 'clock' || failure === 'diagnostic')
                    assert.match(rerunViews[0]!, /Elapsed: unavailable/)
                assert.doesNotMatch(
                    [
                        ...state.output,
                        ...state.statuses,
                        ...state.answers,
                        ...state.diagnostics,
                    ].join('\n'),
                    /private|Bearer|LATE/
                )
            })
        }
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})
