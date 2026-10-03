import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { runCli, type CliDependencies } from './cli-app.ts'
import { CHAT_PROMPT, createNodeLineInput, type ChatSubmission } from './line-input.ts'
import {
    runConversationTurn,
    type RunConversationTurnOptions,
    type RunConversationTurnResult,
} from './runtime/conversation.ts'
import type { ModelRequest, ModelResponse } from './runtime/run.ts'
import { PATCH_APPROVAL_PROMPT } from './terminal-approval.ts'

const finalAnswer = (turn: number): ModelResponse => ({
    type: 'final_answer',
    model: null,
    content: `Answer ${turn}`,
})
const listCall = (turn: number): ModelResponse => ({
    type: 'tool_calls',
    model: null,
    toolCalls: [{ id: `list-${turn}`, name: 'list_files', arguments: { path: '.' } }],
})
type NativeState = {
    stream: PassThrough
    chatPrompts: number
    approvalPrompts: number
    chatReads: { submission: ChatSubmission; settled: number }[]
    approvalReads: string[]
    invocations: RunConversationTurnOptions[]
    requests: ModelRequest[][]
    results: RunConversationTurnResult[]
    localOutput: { text: string; settled: number }[]
    statuses: string[]
    previews: string[]
    errors: string[]
}
const fixture = async ({
    isInteractive,
    onPrompt = () => undefined,
    onApprovalPrompt = () => undefined,
    onPreview = () => undefined,
    respond = (_state, turn, step) => (step === 1 ? listCall(turn) : finalAnswer(turn)),
}: {
    isInteractive: boolean
    onPrompt?: (state: NativeState) => void
    onApprovalPrompt?: (state: NativeState) => void
    onPreview?: (state: NativeState) => void
    respond?: (
        state: NativeState,
        turn: number,
        step: number,
        request: ModelRequest
    ) => ModelResponse | Promise<ModelResponse>
}) => {
    const workspace = await mkdtemp(join(tmpdir(), 'yo-rerun-native-'))
    const path = join(workspace, 'settings.ts')
    await writeFile(path, 'export const version = 1\n')
    const state: NativeState = {
        stream: new PassThrough(),
        chatPrompts: 0,
        approvalPrompts: 0,
        chatReads: [],
        approvalReads: [],
        invocations: [],
        requests: [],
        results: [],
        localOutput: [],
        statuses: [],
        previews: [],
        errors: [],
    }
    const nativeOutput = new Writable({
        write(chunk, _encoding, callback) {
            const text = chunk.toString()
            if (text === CHAT_PROMPT) {
                state.chatPrompts++
                onPrompt(state)
            } else if (text === PATCH_APPROVAL_PROMPT) {
                state.approvalPrompts++
                onApprovalPrompt(state)
            }
            callback()
        },
    })
    const native = createNodeLineInput({ input: state.stream, output: nativeOutput, isInteractive })
    let closeCount = 0
    const dependencies: CliDependencies = {
        transport: async (request) => {
            const turn = state.invocations.length
            const requests = state.requests[turn - 1]!
            requests.push(structuredClone(request))
            return respond(state, turn, requests.length, request)
        },
        runTurn: async (options) => {
            state.invocations.push(options)
            state.requests.push([])
            const result = await runConversationTurn(options)
            state.results.push(structuredClone(result))
            return result
        },
        createLineInput: () => ({
            ...native,
            readChatSubmission: async (prompt, options) => {
                const submission = await native.readChatSubmission!(prompt, options)
                if (submission !== null)
                    state.chatReads.push({ submission, settled: state.results.length })
                return submission
            },
            readLine: async (prompt, options) => {
                const line = await native.readLine(prompt, options)
                if (line !== null) state.approvalReads.push(line)
                return line
            },
            close: () => {
                closeCount++
                native.close()
            },
        }),
        subscribeProcessInterrupt: () => () => undefined,
        writeOutput: (text) => {
            if (!/^Run #\d+ result:/.test(text))
                state.localOutput.push({ text, settled: state.results.length })
        },
        writeError: (text) => state.errors.push(text),
        writeAnswer: (text) => {
            if (text.startsWith('Patch proposal:')) {
                state.previews.push(text)
                onPreview(state)
            }
        },
        writeStatus: (text) => state.statuses.push(text),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive,
        observationClocks: { wallTime: () => 100, monotonicTime: () => 100 },
    }
    return Object.assign(state, {
        path,
        start: () => runCli(['--cwd', workspace], dependencies),
        verify: (tasks: string[], steps: number[]) => {
            assert.deepEqual(state.errors, [])
            assert.equal(closeCount, 1)
            assert.equal(state.stream.listenerCount(isInteractive ? 'keypress' : 'data'), 0)
            assert.equal(state.stream.listenerCount('error'), 0)
            assert.deepEqual(
                state.invocations.map(({ task }) => task),
                tasks
            )
            assert.deepEqual(
                state.requests.map((requests) => requests.length),
                steps
            )
            assert.deepEqual(
                state.results
                    .at(-1)!
                    .conversation.messages.filter((message) => message.role === 'user')
                    .map((message) => message.content),
                tasks
            )
            assert.doesNotMatch(JSON.stringify(state.requests), /\/rerun|windowId|sourceId/)
            const headers = state.statuses.filter((text) => text.startsWith('Run #'))
            assert.equal(headers.length, tasks.length)
            for (const [index, header] of headers.entries())
                assert.ok(header.startsWith(`Run #${index + 1}:`))
        },
        cleanup: async () => {
            native.close()
            state.stream.destroy()
            nativeOutput.destroy()
            await rm(workspace, { recursive: true, force: true })
        },
    })
}

test('native buffered rerun duplicates survive settlement and a fresh prompt allows another action', async (context) => {
    for (const isInteractive of [false, true]) {
        await context.test(isInteractive ? 'interactive' : 'noninteractive', async () => {
            const started = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            const state = await fixture({
                isInteractive,
                onPrompt: (state) => {
                    if (state.chatPrompts === 1) state.stream.write('  source task  \n')
                    if (state.chatPrompts === 2) state.stream.write('/rerun 1\n /rerun\t1 \n')
                    if (state.chatPrompts === 9) {
                        assert.equal(state.results.length, 4)
                        state.stream.write(' /rerun 1 \n')
                    }
                    if (state.chatPrompts === 10)
                        state.stream.write('/runs\n/exit\nnever execute\n')
                },
                respond: async (_state, turn, step) => {
                    if (turn === 2 && step === 1) {
                        started.resolve()
                        await release.promise
                    }
                    return step === 1 ? listCall(turn) : finalAnswer(turn)
                },
            })
            const running = state.start()
            try {
                await started.promise
                state.stream.write(' /rerun  1\nrepeat\nrepeat\n/runs\n/run 1\n')
                assert.equal(state.chatPrompts, 2)
                assert.equal(state.results.length, 1)
                assert.equal(state.invocations.length, 2)
                assert.deepEqual(
                    state.requests.map((requests) => requests.length),
                    [2, 1]
                )
                assert.equal(state.chatReads.length, 2)
                release.resolve()
                assert.equal((await running).exitCode, 0)
                state.verify(
                    ['  source task  ', '  source task  ', 'repeat', 'repeat', '  source task  '],
                    [2, 2, 2, 2, 2]
                )
                assert.deepEqual(
                    state.chatReads.map(({ submission, settled }) => [
                        submission.line,
                        submission.windowId,
                        settled,
                    ]),
                    [
                        ['  source task  ', 1, 0],
                        ['/rerun 1', 2, 1],
                        [' /rerun\t1 ', 2, 2],
                        [' /rerun  1', 2, 2],
                        ['repeat', 2, 2],
                        ['repeat', 2, 3],
                        ['/runs', 2, 4],
                        ['/run 1', 2, 4],
                        [' /rerun 1 ', 9, 4],
                        ['/runs', 10, 5],
                        ['/exit', 10, 5],
                    ]
                )
                assert.deepEqual(
                    state.localOutput.slice(0, 2),
                    Array(2).fill({ text: 'Rerun action already accepted as Run #2.', settled: 2 })
                )
                assert.deepEqual(
                    state.localOutput.map(({ settled }) => settled),
                    [2, 2, 4, 4, 5]
                )
                assert.match(state.localOutput[2]!.text, /#4/)
                assert.doesNotMatch(state.localOutput[2]!.text, /#5/)
                assert.match(state.localOutput[3]!.text, /Run #1/)
                assert.match(state.localOutput[4]!.text, /#5.*Rerun of #1/)
                assert.deepEqual(state.approvalReads, [])
            } finally {
                release.resolve()
                await running
                await state.cleanup()
            }
        })
    }
})

test('native startup EOF drains mixed input and suppresses the final partial rerun duplicate', async (context) => {
    for (const isInteractive of [false, true]) {
        await context.test(isInteractive ? 'interactive' : 'noninteractive', async () => {
            const state = await fixture({ isInteractive })
            try {
                state.stream.end(
                    'source\n/rerun 1\n /rerun\t1 \nrepeat\nrepeat\n/runs\n/run 1\n/rerun  1'
                )
                await new Promise<void>((resolve) => state.stream.on('end', resolve))
                assert.equal((await state.start()).exitCode, 0)
                state.verify(['source', 'source', 'repeat', 'repeat'], [2, 2, 2, 2])
                assert.deepEqual(
                    state.chatReads.map(({ submission }) => submission),
                    [
                        { line: 'source', windowId: 0 },
                        { line: '/rerun 1', windowId: 0 },
                        { line: ' /rerun\t1 ', windowId: 0 },
                        { line: 'repeat', windowId: 0 },
                        { line: 'repeat', windowId: 0 },
                        { line: '/runs', windowId: 0 },
                        { line: '/run 1', windowId: 0 },
                        { line: '/rerun  1', windowId: 0 },
                    ]
                )
                assert.deepEqual(
                    state.localOutput.map(({ settled }) => settled),
                    [2, 4, 4, 4]
                )
                assert.equal(state.localOutput[0]!.text, 'Rerun action already accepted as Run #2.')
                assert.equal(state.localOutput[3]!.text, state.localOutput[0]!.text)
                assert.deepEqual(state.approvalReads, [])
            } finally {
                await state.cleanup()
            }
        })
    }
})

test('native command-like review input denies the rerun patch and keeps later chat ordered', async (context) => {
    for (const isInteractive of [false, true]) {
        await context.test(
            isInteractive ? 'interactive approval owner' : 'non-TTY denies without a reader',
            async () => {
                const queued = '/rerun 1\nnext task\n/runs\n/exit\n'
                const state = await fixture({
                    isInteractive,
                    onPrompt: (state) => {
                        if (state.chatPrompts === 1) state.stream.write('Update settings.ts\n')
                        if (state.chatPrompts === 2) state.stream.write('/rerun 1\n')
                    },
                    onApprovalPrompt: (state) => state.stream.write(queued),
                    onPreview: (state) => {
                        if (!isInteractive) state.stream.write(queued)
                    },
                    respond: (_state, turn, step) =>
                        turn === 2 && step === 1
                            ? {
                                  type: 'tool_calls',
                                  model: null,
                                  toolCalls: [
                                      {
                                          id: 'fresh-patch',
                                          name: 'propose_patch',
                                          arguments: {
                                              path: 'settings.ts',
                                              edits: [
                                                  {
                                                      oldText: 'version = 1',
                                                      newText: 'version = 2',
                                                  },
                                              ],
                                          },
                                      },
                                  ],
                              }
                            : finalAnswer(turn),
                })
                try {
                    assert.equal((await state.start()).exitCode, 0)
                    state.verify(
                        ['Update settings.ts', 'Update settings.ts', 'next task'],
                        [1, 2, 1]
                    )
                    assert.equal(await readFile(state.path, 'utf8'), 'export const version = 1\n')
                    assert.equal(state.previews.length, 1)
                    assert.match(
                        state.previews[0]!,
                        /-export const version = 1\n\+export const version = 2/
                    )
                    assert.equal(state.approvalPrompts, isInteractive ? 1 : 0)
                    assert.deepEqual(state.approvalReads, isInteractive ? ['/rerun 1'] : [])
                    assert.deepEqual(
                        state.chatReads.map(({ submission }) => submission),
                        [
                            { line: 'Update settings.ts', windowId: 1 },
                            { line: '/rerun 1', windowId: 2 },
                            ...(isInteractive ? [] : [{ line: '/rerun 1', windowId: 2 }]),
                            { line: 'next task', windowId: 2 },
                            { line: '/runs', windowId: 2 },
                            { line: '/exit', windowId: 2 },
                        ]
                    )
                    const result = state.results[1]!.turn.messages.find(
                        (message) => message.role === 'tool'
                    )
                    assert.equal(result?.role, 'tool')
                    if (result?.role !== 'tool') throw new Error('Missing patch result')
                    assert.equal(result.result.status, 'denied')
                    const resolved = state.results[1]!.turn.session.events.filter(
                        (event) => event.type === 'patch_approval_resolved'
                    )
                    assert.equal(resolved.length, 1)
                    assert.equal(resolved[0]!.decision, 'denied')
                    assert.equal(state.localOutput.length, isInteractive ? 1 : 2)
                    if (!isInteractive)
                        assert.equal(
                            state.localOutput[0]!.text,
                            'Rerun action already accepted as Run #2.'
                        )
                    assert.match(state.localOutput.at(-1)!.text, /#3/)
                } finally {
                    await state.cleanup()
                }
            }
        )
    }
})
