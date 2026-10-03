import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runCli, type CliDependencies } from './cli-app.ts'
import { CHAT_PROMPT, LineReadAbortedError, type ChatSubmission } from './line-input.ts'
import {
    runConversationTurn,
    type RunConversationTurnOptions,
    type RunConversationTurnResult,
} from './runtime/conversation.ts'
import type { PatchApprovalView } from './runtime/patch-contracts.ts'
import type { ModelResponse, ModelTransport, SessionMessage } from './runtime/run.ts'
import { PATCH_APPROVAL_PROMPT } from './terminal-approval.ts'

const gate = <T>() => Promise.withResolvers<T>()
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const finalAnswer = (content: string): ModelResponse => ({
    type: 'final_answer',
    model: null,
    content,
})
const sourceBytes = 'export const value = 1\n'
const appliedBytes = 'export const value = 2\n'
const completeDiff =
    '--- value.ts\n+++ value.ts\n-export const value = 1\n+export const value = 2\n'
const propose = (turn: number): ModelResponse => ({
    type: 'tool_calls',
    model: null,
    toolCalls: [
        {
            id: `patch-${turn}`,
            name: 'propose_patch',
            arguments: {
                path: 'value.ts',
                edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
            },
        },
    ],
})
const toolResults = (messages: readonly SessionMessage[]) =>
    messages.filter((message) => message.role === 'tool').map((message) => message.result)

type ApprovalRead = { signal: AbortSignal; response: ReturnType<typeof gate<string | null>> }
const fixture = async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'yo-rerun-cancel-'))
    const path = join(workspace, 'value.ts')
    await writeFile(path, sourceBytes)
    const invocations: RunConversationTurnOptions[] = []
    const results: RunConversationTurnResult[] = []
    const requests: Parameters<ModelTransport>[0][][] = []
    const proposals: PatchApprovalView[] = []
    const output: string[] = [],
        statuses: string[] = [],
        answers: string[] = [],
        errors: string[] = []
    const chatReady = Array.from({ length: 12 }, () =>
        gate<ReturnType<typeof gate<ChatSubmission | null>>>()
    )
    const approvalReady = Array.from({ length: 4 }, () => gate<ApprovalRead>())
    let chatReads = 0,
        approvalReads = 0,
        owners = 0,
        closes = 0,
        discards = 0
    let interrupt: (() => void) | undefined
    let ending = false
    let pendingChat: ReturnType<typeof gate<ChatSubmission | null>> | undefined
    const pendingApprovals: ReturnType<typeof gate<string | null>>[] = []
    let running: ReturnType<typeof runCli> | undefined
    const ownRead = () => {
        assert.equal(owners, 0, 'chat and exact review must share one input owner')
        owners++
        return () => {
            owners--
        }
    }
    const dependencies: CliDependencies = {
        transport: async () => finalAnswer('Done.'),
        runTurn: async (options) => {
            assert.equal(options.signal?.aborted, false)
            invocations.push(options)
            requests.push([])
            const terminalApprover = options.patchApprover!
            const result = await runConversationTurn({
                ...options,
                transport: async (request, transportOptions) => {
                    assert.equal(transportOptions?.signal, options.signal)
                    requests.at(-1)!.push(structuredClone(request))
                    return options.transport(request, transportOptions)
                },
                patchApprover: async (view, approvalOptions) => {
                    proposals.push(structuredClone(view))
                    return terminalApprover(view, approvalOptions)
                },
            })
            results.push(result)
            return result
        },
        createLineInput: () => ({
            readChatSubmission: (prompt) => {
                assert.equal(prompt, CHAT_PROMPT)
                if (ending) return Promise.resolve(null)
                const release = ownRead()
                const response = gate<ChatSubmission | null>()
                pendingChat = response
                chatReady[chatReads++]!.resolve(response)
                return response.promise.finally(release)
            },
            readLine: (prompt, options) => {
                assert.equal(prompt, PATCH_APPROVAL_PROMPT)
                assert.ok(options?.signal)
                const release = ownRead()
                const response = gate<string | null>()
                pendingApprovals.push(response)
                approvalReady[approvalReads++]!.resolve({ signal: options.signal, response })
                // Keep the old delivery gate so a late reply can be injected during fresh review.
                // Aborting releases its owner; that gate can never resolve a subsequent read.
                const signal = options.signal
                let abort!: () => void
                return new Promise<string | null>((resolve, reject) => {
                    abort = () => reject(new LineReadAbortedError())
                    signal.addEventListener('abort', abort, { once: true })
                    response.promise.then(resolve)
                    if (signal.aborted) abort()
                }).finally(() => {
                    signal.removeEventListener('abort', abort)
                    release()
                })
            },
            discardUntilNextRead: () => {
                discards++
            },
            close: () => {
                closes++
            },
        }),
        subscribeProcessInterrupt: (listener) => {
            interrupt = listener
            return () => {
                interrupt = undefined
            }
        },
        writeOutput: (text) => output.push(text),
        writeError: (text) => errors.push(text),
        writeAnswer: (text) => answers.push(text),
        writeStatus: (text) => statuses.push(text),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: true,
        observationClocks: { wallTime: () => 100, monotonicTime: () => 100 },
    }
    return {
        path,
        workspace,
        dependencies,
        invocations,
        results,
        requests,
        proposals,
        output,
        statuses,
        answers,
        errors,
        turn: () => invocations.length,
        step: () => requests.at(-1)!.length,
        prompt: (number: number) => chatReady[number - 1]!.promise,
        submit: async (number: number, line: string) => {
            const pending = await chatReady[number - 1]!.promise
            pending.resolve({ line, windowId: number })
        },
        approval: (number: number) => approvalReady[number - 1]!.promise,
        interrupt: () => {
            assert.ok(interrupt)
            interrupt()
        },
        counts: () => ({ chatReads, approvalReads, owners, closes, discards }),
        start: () => {
            running = runCli(['--cwd', workspace], dependencies)
            return running
        },
        cleanup: async () => {
            ending = true
            pendingChat?.resolve(null)
            for (const response of pendingApprovals) response.resolve(null)
            await running
            await rm(workspace, { recursive: true, force: true })
        },
    }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const assertFreshSignals = (state: Fixture) => {
    assert.equal(
        new Set(state.invocations.map(({ signal }) => signal)).size,
        state.invocations.length
    )
    for (const invocation of state.invocations)
        assert.deepEqual(invocation.budget, { maxSteps: 10, perToolTimeoutMs: 5000 })
    assert.deepEqual(state.errors, [])
    assert.equal(state.counts().closes, 1)
    assert.equal(state.counts().owners, 0)
}
const inspect = async (state: Fixture, prompt: number, run: number): Promise<string> => {
    await state.prompt(prompt)
    const index = state.output.length
    await state.submit(prompt, `/run ${run}`)
    await state.prompt(prompt + 1)
    assert.equal(state.output.length, index + 1)
    return state.output[index]!
}

test('cancelled source review cannot supply late consent to a newly prepared rerun patch', async () => {
    const state = await fixture()
    state.dependencies.transport = async () =>
        state.step() === 1 ? propose(state.turn()) : finalAnswer('Fresh patch answer')
    const running = state.start()
    try {
        await state.submit(1, 'Patch value.ts')
        const oldReview = await state.approval(1)
        assert.equal(state.answers.at(-1), `Patch proposal: value.ts\n${completeDiff}\n`)
        state.interrupt()
        await state.prompt(2)
        const sourceSnapshot = structuredClone(state.results[0])
        assert.equal(oldReview.signal.aborted, true)
        assert.equal(state.results[0]!.turn.session.stopReason, 'aborted')
        assert.deepEqual(
            toolResults(state.results[0]!.turn.messages).map(({ callId, status }) => ({
                callId,
                status,
            })),
            [{ callId: 'patch-1', status: 'aborted' }]
        )
        const oldDecision = state.results[0]!.turn.session.events.filter(
            (event) => event.type === 'patch_approval_resolved'
        )
        assert.equal(oldDecision.length, 1)
        assert.equal(oldDecision[0]!.decision, 'aborted')
        assert.equal(oldDecision[0]!.metadata.proposalId, state.proposals[0]!.id)
        assert.equal(await readFile(state.path, 'utf8'), sourceBytes)
        const before = await inspect(state, 2, 1)
        await state.submit(3, '/rerun 1')
        const newReview = await state.approval(2)
        assert.equal(newReview.signal.aborted, false)
        assert.notEqual(newReview.signal, oldReview.signal)
        assert.equal(state.proposals.length, 2)
        assert.notEqual(state.proposals[1]!.id, state.proposals[0]!.id)
        assert.equal(state.proposals[1]!.diff, completeDiff)
        assert.equal(state.answers.at(-1), `Patch proposal: value.ts\n${completeDiff}\n`)
        oldReview.response.resolve('yes')
        await tick()
        assert.equal(state.results.length, 1)
        assert.equal(state.counts().chatReads, 3)
        assert.equal(await readFile(state.path, 'utf8'), sourceBytes)
        newReview.response.resolve('yes')
        await state.prompt(4)
        assert.equal(await readFile(state.path, 'utf8'), appliedBytes)
        assert.equal(toolResults(state.results[1]!.turn.messages)[0]!.status, 'success')
        assert.deepEqual(
            state.requests.map((requests) => requests.length),
            [1, 2]
        )
        assert.deepEqual(
            state.results[1]!.conversation.messages.filter((message) => message.role === 'user'),
            [
                { role: 'user', content: 'Patch value.ts' },
                { role: 'user', content: 'Patch value.ts' },
            ]
        )
        assert.deepEqual(state.requests[1]![0]!.messages, [
            ...sourceSnapshot!.conversation.messages,
            { role: 'user', content: 'Patch value.ts' },
        ])
        const after = await inspect(state, 4, 1)
        assert.equal(after, before)
        assert.deepEqual(state.results[0], sourceSnapshot)
        assert.match(after, /Run #1 result: cancelled/)
        assert.doesNotMatch(after, /patch_applied|Fresh patch answer/)
        await state.submit(5, '/exit')
        assert.equal((await running).exitCode, 0)
        assert.deepEqual(await readdir(state.workspace), ['value.ts'])
        assertFreshSignals(state)
    } finally {
        await state.cleanup()
    }
})

test('cancelled rerun waits for held transport cleanup, never retries, then uses a fresh signal', async () => {
    const state = await fixture()
    const entered = gate<void>(),
        aborted = gate<void>(),
        cleanup = gate<void>()
    let abortCount = 0
    state.dependencies.transport = async (_request, options) => {
        if (state.turn() === 2) {
            options!.signal!.addEventListener(
                'abort',
                () => {
                    abortCount++
                    aborted.resolve()
                },
                { once: true }
            )
            entered.resolve()
            await aborted.promise
            await cleanup.promise
            return finalAnswer('Late rerun answer')
        }
        return finalAnswer(state.turn() === 1 ? 'Source answer' : 'Fresh answer')
    }
    const running = state.start()
    try {
        await state.submit(1, 'Original task')
        const before = await inspect(state, 2, 1)
        const sourceSnapshot = structuredClone(state.results[0])
        await state.submit(3, '/rerun 1')
        await entered.promise
        state.interrupt()
        state.interrupt()
        await aborted.promise
        await tick()
        assert.equal(abortCount, 1)
        assert.equal(state.counts().chatReads, 3)
        assert.equal(state.counts().discards, 1)
        assert.equal(state.results.length, 1)
        assert.equal(state.invocations.length, 2)
        assert.deepEqual(
            state.requests.map((requests) => requests.length),
            [1, 1]
        )
        assert.equal(state.output.length, 2)
        assert.match(state.statuses.join(''), /cancellation requested/)
        assert.equal(state.statuses.join('').match(/run_cancellation_requested/g)?.length, 1)
        assert.doesNotMatch(state.output.join(''), /Run #2 result:/)
        assert.deepEqual(state.results[0], sourceSnapshot)
        cleanup.resolve()
        await state.prompt(4)
        await tick()
        assert.equal(
            state.invocations.length,
            2,
            'cancelled settlement cannot schedule automatic retry'
        )
        assert.equal(state.results[1]!.turn.session.stopReason, 'aborted')
        assert.deepEqual(state.results[1]!.turn.messages, [
            { role: 'user', content: 'Original task' },
        ])
        assert.match(state.output.at(-1)!, /Run #2 result: cancelled\nRerun of #1/)
        assert.doesNotMatch(state.answers.join(''), /Late rerun answer/)
        assert.equal(await inspect(state, 4, 1), before)
        const cancelled = await inspect(state, 5, 2)
        assert.match(cancelled, /Run #2 result: cancelled/)
        await state.submit(6, '/rerun 2')
        await state.prompt(7)
        assert.equal(state.invocations[1]!.signal!.aborted, true)
        assert.equal(state.invocations[2]!.signal!.aborted, false)
        assert.equal(state.invocations[0]!.signal!.aborted, false)
        assert.deepEqual(state.requests[2]![0]!.messages, [
            ...state.results[1]!.conversation.messages,
            { role: 'user', content: 'Original task' },
        ])
        assert.match(state.output.at(-1)!, /Run #3 result: completed\nRerun of #2/)
        assert.equal(await inspect(state, 7, 2), cancelled)
        assert.deepEqual(state.results[0], sourceSnapshot)
        await state.submit(8, '/exit')
        assert.equal((await running).exitCode, 0)
        assert.deepEqual(
            state.requests.map((requests) => requests.length),
            [1, 1, 1]
        )
        assertFreshSignals(state)
    } finally {
        cleanup.resolve()
        await state.cleanup()
    }
})

test('rerun completion wins cancellation after commit and still awaits outer settlement', async (context) => {
    for (const phase of ['answer-event', 'outer-promise'] as const)
        await context.test(phase, async () => {
            const state = await fixture()
            const committed = gate<void>(),
                release = gate<void>()
            const runTurn = state.dependencies.runTurn!
            state.dependencies.runTurn = async (options) => {
                const result = await runTurn({
                    ...options,
                    onEvent: (event) => {
                        options.onEvent?.(event)
                        if (
                            state.turn() === 2 &&
                            event.type === 'final_answer' &&
                            phase === 'answer-event'
                        )
                            state.interrupt()
                    },
                })
                if (state.turn() === 2) {
                    committed.resolve()
                    await release.promise
                }
                return result
            }
            state.dependencies.transport = async () =>
                finalAnswer(state.turn() === 1 ? 'Source answer' : 'Committed rerun answer')
            const running = state.start()
            try {
                await state.submit(1, 'Complete task')
                const before = await inspect(state, 2, 1)
                const sourceSnapshot = structuredClone(state.results[0])
                await state.submit(3, '/rerun 1')
                await committed.promise
                state.interrupt()
                state.interrupt()
                await tick()
                assert.equal(state.counts().chatReads, 3)
                assert.equal(state.invocations[1]!.signal!.aborted, true)
                assert.equal(state.results[1]!.turn.session.status, 'completed')
                assert.equal(state.results[1]!.turn.session.stopReason, 'final_answer')
                assert.doesNotMatch(state.output.join(''), /Run #2 result:/)
                assert.equal(
                    state.results[1]!.turn.session.events.filter(
                        ({ type }) => type === 'run_cancellation_requested'
                    ).length,
                    0
                )
                release.resolve()
                await state.prompt(4)
                assert.match(state.output.at(-1)!, /Run #2 result: completed\nRerun of #1/)
                assert.doesNotMatch(state.output.join(''), /cancelled/)
                assert.equal(state.answers.join('').match(/Committed rerun answer/g)?.length, 1)
                assert.equal(await inspect(state, 4, 1), before)
                assert.deepEqual(state.results[0], sourceSnapshot)
                await state.submit(5, '/exit')
                assert.equal((await running).session?.status, 'completed')
                assert.equal(state.invocations.length, 2)
                assertFreshSignals(state)
            } finally {
                release.resolve()
                await state.cleanup()
            }
        })
})

test('source retains applied patch and cancelled evidence unchanged after its rerun completes', async () => {
    const state = await fixture()
    const waiting = gate<void>(),
        cleanup = gate<void>()
    state.dependencies.transport = async () => {
        if (state.turn() === 1) {
            if (state.step() === 1) return propose(1)
            waiting.resolve()
            await cleanup.promise
            return finalAnswer('Late source answer')
        }
        return state.step() === 1
            ? {
                  type: 'tool_calls',
                  model: null,
                  toolCalls: [
                      { id: 'rerun-read', name: 'read_file', arguments: { path: 'value.ts' } },
                  ],
              }
            : finalAnswer('Rerun reads applied bytes')
    }
    const running = state.start()
    try {
        await state.submit(1, 'Update or inspect value.ts')
        const review = await state.approval(1)
        review.response.resolve('y')
        await waiting.promise
        assert.equal(await readFile(state.path, 'utf8'), appliedBytes)
        state.interrupt()
        cleanup.resolve()
        await state.prompt(2)
        const sourceSnapshot = structuredClone(state.results[0])
        assert.equal(sourceSnapshot!.turn.session.status, 'aborted')
        assert.equal(sourceSnapshot!.turn.session.stopReason, 'aborted')
        assert.equal(toolResults(sourceSnapshot!.turn.messages)[0]!.status, 'success')
        assert.equal(
            sourceSnapshot!.turn.session.events.filter(({ type }) => type === 'patch_applied')
                .length,
            1
        )
        const before = await inspect(state, 2, 1)
        assert.match(before, /Run #1 result: cancelled/)
        assert.match(before, /patch_applied/)
        assert.match(before, /prepared -> waiting -> approved -> applied/)
        await state.submit(3, '/rerun 1')
        await state.prompt(4)
        assert.equal(state.results[1]!.turn.session.status, 'completed')
        assert.equal(
            toolResults(state.results[1]!.turn.messages)[0]!.content,
            '1:export const value = 2'
        )
        assert.deepEqual(state.requests[1]![0]!.messages, [
            ...sourceSnapshot!.conversation.messages,
            { role: 'user', content: 'Update or inspect value.ts' },
        ])
        assert.equal(await inspect(state, 4, 1), before)
        const rerun = await inspect(state, 5, 2)
        assert.match(rerun, /Rerun of #1/)
        assert.match(rerun, /Rerun reads applied bytes/)
        assert.doesNotMatch(rerun, /patch_applied|approval_requested|cancelled/)
        assert.deepEqual(state.results[0], sourceSnapshot)
        assert.equal(await readFile(state.path, 'utf8'), appliedBytes)
        assert.equal(state.proposals.length, 1)
        assert.equal(state.counts().approvalReads, 1)
        assert.doesNotMatch(state.answers.join(''), /Late source answer/)
        await state.submit(6, '/exit')
        assert.equal((await running).exitCode, 0)
        assert.deepEqual(
            state.requests.map((requests) => requests.length),
            [2, 2]
        )
        assert.deepEqual(await readdir(state.workspace), ['value.ts'])
        assertFreshSignals(state)
    } finally {
        cleanup.resolve()
        await state.cleanup()
    }
})
