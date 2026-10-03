import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runCli, type CliDependencies } from './cli-app.ts'
import {
    runConversationTurn,
    type RunConversationTurnOptions,
    type RunConversationTurnResult,
} from './runtime/conversation.ts'
import type { ModelResponse } from './runtime/run.ts'

type ResponseContext = { turn: number; step: number; interrupt: () => void }
const finalAnswer = (content: string): ModelResponse => ({
    type: 'final_answer',
    model: null,
    content,
})
const listCall = (turn: number, step: number): ModelResponse => ({
    type: 'tool_calls',
    model: null,
    content: `Inspect attempt ${turn}, step ${step}`,
    toolCalls: [
        { id: `attempt-${turn}-step-${step}`, name: 'list_files', arguments: { path: '.' } },
    ],
})
const fixture = async (
    lines: readonly string[],
    respond: (context: ResponseContext) => ModelResponse = ({ turn, step }) =>
        step === 1 ? listCall(turn, step) : finalAnswer(`Answer ${turn}`)
) => {
    const workspace = await mkdtemp(join(tmpdir(), 'yo-rerun-execution-'))
    const pending = [...lines]
    const invocations: RunConversationTurnOptions[] = []
    const results: RunConversationTurnResult[] = []
    const requests: Parameters<CliDependencies['transport']>[0][][] = []
    const transportSignals: (AbortSignal | undefined)[][] = []
    const output: string[] = [],
        statuses: string[] = [],
        errors: string[] = []
    let interrupt: (() => void) | undefined
    const dependencies: CliDependencies = {
        transport: async (request, options) => {
            const turn = invocations.length
            requests[turn - 1]!.push(structuredClone(request))
            transportSignals[turn - 1]!.push(options?.signal)
            return respond({
                turn,
                step: requests[turn - 1]!.length,
                interrupt: () => {
                    assert.ok(interrupt)
                    interrupt()
                },
            })
        },
        runTurn: async (options) => {
            assert.equal(options.signal?.aborted, false)
            invocations.push(options)
            requests.push([])
            transportSignals.push([])
            const result = await runConversationTurn(options)
            results.push(structuredClone(result))
            return result
        },
        createLineInput: () => ({
            readLine: async () => {
                throw new Error('Unexpected approval read')
            },
            readChatSubmission: async () => {
                const line = pending.shift()
                return line === undefined
                    ? null
                    : { line, windowId: 700_000 + lines.length - pending.length }
            },
            close: () => undefined,
        }),
        subscribeProcessInterrupt: (listener) => {
            interrupt = listener
            return () => {
                interrupt = undefined
            }
        },
        writeOutput: (text) => output.push(text),
        writeError: (text) => errors.push(text),
        writeAnswer: () => undefined,
        writeStatus: (text) => statuses.push(text),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: false,
        observationClocks: { wallTime: () => 100, monotonicTime: () => 100 },
    }
    return {
        invocations,
        results,
        requests,
        transportSignals,
        output,
        statuses,
        errors,
        start: () => runCli(['--cwd', workspace, '--model', 'faux-rerun'], dependencies),
        cleanup: () => rm(workspace, { recursive: true, force: true }),
    }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const verifyFreshTurns = (state: Fixture) => {
    assert.equal(
        new Set(state.invocations.map(({ signal }) => signal)).size,
        state.invocations.length
    )
    for (const [index, invocation] of state.invocations.entries()) {
        assert.ok(invocation.signal)
        assert.deepEqual(invocation.budget, { maxSteps: 10, perToolTimeoutMs: 5000 })
        assert.equal(invocation.conversation.model, 'faux-rerun')
        assert.ok(state.transportSignals[index]!.every((signal) => signal === invocation.signal))
        assert.ok(
            state.results[index]!.turn.messages.filter((message) => message.role === 'tool').every(
                (message) => message.result.status === 'success'
            )
        )
        assert.deepEqual(state.results[index]!.turn.session.events[0], {
            type: 'run_started',
            task: invocation.task,
            workspaceRoot: invocation.conversation.workspaceRoot,
            budget: { maxSteps: 10, perToolTimeoutMs: 5000 },
        })
    }
}

test('rerun appends the exact source task to current corrected context once and links direct chains', async () => {
    const source = ` \tInspect ${'🧩'.repeat(180)} in full.\nKeep original whitespace. \t `
    const correction = 'Correction: use the revised interpretation from this turn.'
    const state = await fixture([source, correction, '/rerun 1', '/rerun 3', '/exit'])
    try {
        assert.equal((await state.start()).exitCode, 0)
        assert.deepEqual(
            state.invocations.map(({ task }) => task),
            [source, correction, source, source]
        )
        for (const [index, invocation] of state.invocations.entries()) {
            const before =
                index === 0
                    ? invocation.conversation.messages
                    : state.results[index - 1]!.conversation.messages
            assert.deepEqual(invocation.conversation.messages, before)
            assert.deepEqual(state.requests[index]![0]!.messages, [
                ...before,
                { role: 'user', content: invocation.task },
            ])
            assert.deepEqual(state.results[index]!.conversation.messages, [
                ...before,
                ...state.results[index]!.turn.messages,
            ])
            assert.equal(state.results[index]!.turn.messages.length, 4)
            assert.deepEqual(state.results[index]!.turn.messages[0], {
                role: 'user',
                content: invocation.task,
            })
            assert.equal(state.results[index]!.turn.session.stepCount, 2)
        }
        const lastMessages = state.results.at(-1)!.conversation.messages
        assert.equal(lastMessages.filter(({ role }) => role === 'system').length, 1)
        assert.deepEqual(
            lastMessages
                .filter((message) => message.role === 'user')
                .map((message) => message.content),
            [source, correction, source, source]
        )
        assert.deepEqual(
            lastMessages
                .filter((message) => message.role === 'tool')
                .map((message) => message.result.callId),
            [1, 2, 3, 4].map((turn) => `attempt-${turn}-step-1`)
        )
        const modelText = JSON.stringify(state.requests)
        assert.doesNotMatch(modelText, /\/rerun|windowId|sourceId|current_conversation|70000[1-5]/)
        const headers = state.statuses.filter((text) => text.startsWith('Run #'))
        assert.equal(headers.length, 4)
        assert.match(headers[2]!, /^Run #3:.*Rerun of #1.*Context: current conversation/)
        assert.match(headers[3]!, /^Run #4:.*Rerun of #3.*Context: current conversation/)
        verifyFreshTurns(state)
        assert.deepEqual(state.errors, [])
    } finally {
        await state.cleanup()
    }
})

test('actual completed, transport-failed, exhausted, and cancelled sources all accept a fresh rerun', async (context) => {
    for (const outcome of ['completed', 'transport-failed', 'exhausted', 'cancelled'] as const) {
        await context.test(outcome, async () => {
            const state = await fixture(
                ['Original task', '/rerun 1', '/exit'],
                ({ turn, step, interrupt }) => {
                    if (turn > 1)
                        return step === 1 ? listCall(turn, step) : finalAnswer('Rerun answer')
                    if (outcome === 'exhausted' || step === 1) return listCall(turn, step)
                    if (outcome === 'transport-failed') throw new Error('Faux transport failure')
                    if (outcome === 'cancelled') {
                        interrupt()
                        return finalAnswer('Late source answer')
                    }
                    return finalAnswer('Source answer')
                }
            )
            try {
                const result = await state.start()
                assert.equal(result.exitCode, 0)
                assert.equal(state.results.length, 2)
                const source = state.results[0]!.turn.session
                const expected = {
                    completed: ['completed', 'final_answer'],
                    'transport-failed': ['failed', 'transport_error'],
                    exhausted: ['aborted', 'step_budget_exhausted'],
                    cancelled: ['aborted', 'aborted'],
                }[outcome]
                assert.deepEqual([source.status, source.stopReason], expected)
                assert.equal(source.stepCount, outcome === 'exhausted' ? 10 : 2)
                assert.equal(
                    source.messages.filter(({ role }) => role === 'tool').length,
                    outcome === 'exhausted' ? 10 : 1
                )
                assert.deepEqual(state.requests[1]![0]!.messages, [
                    ...source.messages,
                    { role: 'user', content: 'Original task' },
                ])
                assert.deepEqual(
                    state.results[1]!.turn.messages.map(({ role }) => role),
                    ['user', 'assistant', 'tool', 'assistant']
                )
                assert.equal(result.session?.status, 'completed')
                assert.equal(result.session?.stepCount, 2)
                assert.equal(state.requests.flat().length, outcome === 'exhausted' ? 12 : 4)
                assert.equal(state.invocations[0]!.signal!.aborted, outcome === 'cancelled')
                assert.equal(state.invocations[1]!.signal!.aborted, false)
                assert.match(state.output.at(-1)!, /^Run #2 result: completed\nRerun of #1\n/)
                verifyFreshTurns(state)
                assert.deepEqual(state.errors, [])
            } finally {
                await state.cleanup()
            }
        })
    }
})

test('rerun after exhaustion gets all ten requests and a new 5000 ms timer for each tool execution', async (context) => {
    const state = await fixture(['Use the full budget', '/rerun 1', '/exit'], ({ turn, step }) =>
        turn === 2 && step === 10
            ? finalAnswer('Completed on fresh step ten')
            : listCall(turn, step)
    )
    const timers = context.mock.method(globalThis, 'setTimeout')
    try {
        const result = await state.start()
        assert.equal(result.exitCode, 0)
        assert.deepEqual(
            state.requests.map((requests) => requests.length),
            [10, 10]
        )
        assert.deepEqual(
            state.results.map(({ turn }) => [turn.session.stepCount, turn.session.stopReason]),
            [
                [10, 'step_budget_exhausted'],
                [10, 'final_answer'],
            ]
        )
        assert.deepEqual(
            state.results.map(({ turn }) =>
                turn.session.events
                    .filter((event) => event.type === 'model_requested')
                    .map((event) => event.step)
            ),
            [
                Array.from({ length: 10 }, (_, index) => index + 1),
                Array.from({ length: 10 }, (_, index) => index + 1),
            ]
        )
        assert.deepEqual(
            timers.mock.calls.map(({ arguments: args }) => args[1]),
            Array(19).fill(5000)
        )
        assert.equal(
            state.results[1]!.turn.messages.filter(({ role }) => role === 'tool').length,
            9
        )
        assert.equal(result.session?.finalAnswer, 'Completed on fresh step ten')
        verifyFreshTurns(state)
        assert.deepEqual(state.errors, [])
    } finally {
        timers.mock.restore()
        await state.cleanup()
    }
})
