import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { runCli, type CliDependencies } from './cli-app.ts'
import { createNodeLineInput, CHAT_PROMPT } from './line-input.ts'
import { runConversationTurn } from './runtime/conversation.ts'
import type { ModelRequest, ModelTransport } from './runtime/run.ts'
import { PATCH_APPROVAL_PROMPT } from './terminal-approval.ts'

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const answer: ModelTransport = async () => ({ type: 'final_answer', model: null, content: 'Done.' })
const fixture = async (lines: string[], transport: ModelTransport = answer) => {
    const workspace = await mkdtemp(join(tmpdir(), 'yo-cancel-cli-'))
    const output: string[] = [],
        statuses: string[] = [],
        errors: string[] = [],
        answers: string[] = []
    let interrupt: (() => void) | undefined
    let reads = 0,
        closes = 0,
        disposed = 0
    const subscribe = (listener: () => void) => {
        interrupt = listener
        return () => {
            disposed += 1
            interrupt = undefined
        }
    }
    const dependencies: CliDependencies = {
        transport,
        writeOutput: (value) => output.push(value),
        writeError: (value) => errors.push(value),
        writeAnswer: (value) => answers.push(value),
        writeStatus: (value) => statuses.push(value),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: false,
        subscribeProcessInterrupt: subscribe,
        createLineInput: () => ({
            readLine: async () => {
                reads += 1
                return lines.shift() ?? null
            },
            subscribeInterrupt: () => {
                throw new Error('non-TTY must use process route')
            },
            close: () => {
                closes += 1
            },
        }),
        observationClocks: { wallTime: () => 100, monotonicTime: () => 100 },
    }
    return {
        workspace,
        dependencies,
        output,
        statuses,
        errors,
        answers,
        subscribe,
        interrupt: () => {
            assert.ok(interrupt)
            interrupt()
        },
        counts: () => ({ reads, closes, disposed }),
        start: () => runCli(['--cwd', workspace], dependencies),
        cleanup: () => rm(workspace, { recursive: true, force: true }),
    }
}

test('non-TTY interruption waits for cleanup, ignores repeats, then permits inspection and fresh context', async () => {
    const entered = deferred<void>(),
        cleanup = deferred<void>()
    const requests: ModelRequest[] = []
    let aborts = 0
    const state = await fixture(
        ['Slow task', '/runs', '/run 1', 'Fresh task', '/exit'],
        async (request, options) => {
            requests.push(structuredClone(request))
            if (requests.length === 1) {
                options?.signal?.addEventListener('abort', () => {
                    aborts += 1
                })
                entered.resolve()
                await cleanup.promise
            }
            return {
                type: 'final_answer',
                model: null,
                content: requests.length === 1 ? 'Late answer' : 'Fresh answer',
            }
        }
    )
    try {
        const running = state.start()
        await entered.promise
        state.interrupt()
        state.interrupt()
        await tick()
        assert.deepEqual(state.counts(), { reads: 1, closes: 0, disposed: 0 })
        assert.equal(aborts, 1)
        assert.match(state.statuses.join(''), /cancellation requested/)
        assert.equal(state.statuses.join('').match(/run_cancellation_requested/g)?.length, 1)
        assert.deepEqual(state.output, [])
        cleanup.resolve()
        const result = await running
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'completed')
        assert.equal(result.session?.stepCount, 1)
        assert.deepEqual(result.session?.budget, { maxSteps: 10, perToolTimeoutMs: 5000 })
        assert.equal(requests.length, 2)
        assert.deepEqual(
            requests[1]?.messages.filter((message) => message.role === 'user'),
            [
                { role: 'user', content: 'Slow task' },
                { role: 'user', content: 'Fresh task' },
            ]
        )
        assert.doesNotMatch(state.answers.join(''), /Late answer/)
        assert.match(state.output[0]!, /Run #1 result: cancelled/)
        assert.match(state.output[1]!, /#1 Slow task \| cancelled/)
        assert.match(state.output[2]!, /Run #1 result: cancelled/)
        assert.match(state.output[3]!, /Run #2 result: completed/)
        assert.deepEqual(state.counts(), { reads: 5, closes: 1, disposed: 1 })
        assert.deepEqual(state.errors, [])
    } finally {
        cleanup.resolve()
        await state.cleanup()
    }
})

test('controller is registered before synchronous initial events', async () => {
    let requests = 0
    const state = await fixture(['Task', '/exit'], async () => {
        requests += 1
        return { type: 'final_answer', model: null, content: 'Unused' }
    })
    state.dependencies.writeStatus = (value) => {
        state.statuses.push(value)
        if (value.includes('run_started')) state.interrupt()
    }
    try {
        const result = await state.start()
        assert.equal(requests, 0)
        assert.equal(result.session?.status, 'aborted')
        assert.equal(result.session?.stopReason, 'aborted')
        assert.match(state.output[0]!, /cancelled/)
        assert.equal(state.counts().disposed, 1)
    } finally {
        await state.cleanup()
    }
})

test('completion committed before interrupt survives a held outer turn promise', async () => {
    const committed = deferred<void>(),
        release = deferred<void>()
    const state = await fixture(['Task', '/exit'])
    state.dependencies.runTurn = async (options) => {
        const result = await runConversationTurn(options)
        committed.resolve()
        await release.promise
        return result
    }
    try {
        const running = state.start()
        await committed.promise
        state.interrupt()
        state.interrupt()
        await tick()
        assert.equal(state.counts().reads, 1)
        release.resolve()
        const result = await running
        assert.equal(result.session?.status, 'completed')
        assert.match(state.output[0]!, /Run #1 result: completed/)
        assert.doesNotMatch(state.output.join(''), /cancelled/)
    } finally {
        release.resolve()
        await state.cleanup()
    }
})

test('native readline Ctrl+C cancels approval and discards late consent until the fresh prompt', async () => {
    const stream = new PassThrough(),
        terminal = new PassThrough()
    const native = createNodeLineInput({ input: stream, output: terminal, isInteractive: true })
    const approval = deferred<void>(),
        settled = deferred<void>(),
        release = deferred<void>(),
        nextPrompt = deferred<void>()
    const state = await fixture([], answer)
    const source = join(state.workspace, 'value.ts')
    let reads = 0,
        processSubscriptions = 0,
        inputDisposed = 0
    let processInterrupt: (() => void) | undefined
    const requests: ModelRequest[] = []
    state.dependencies.isInteractive = true
    state.dependencies.subscribeProcessInterrupt = (listener) => {
        processSubscriptions += 1
        processInterrupt = listener
        return () => {
            processInterrupt = undefined
        }
    }
    state.dependencies.createLineInput = () => ({
        ...native,
        readLine: (prompt, options) => {
            reads += 1
            const result = native.readLine(prompt, options)
            if (prompt === PATCH_APPROVAL_PROMPT) approval.resolve()
            if (reads === 3 && prompt === CHAT_PROMPT) nextPrompt.resolve()
            return result
        },
        subscribeInterrupt: (listener) => {
            const dispose = native.subscribeInterrupt!(listener)
            return () => {
                inputDisposed += 1
                dispose()
            }
        },
    })
    state.dependencies.transport = async (request) => {
        requests.push(structuredClone(request))
        return requests.length === 1
            ? {
                  type: 'tool_calls',
                  model: null,
                  toolCalls: [
                      {
                          id: 'patch',
                          name: 'propose_patch',
                          arguments: { path: 'value.ts', edits: [{ oldText: '1', newText: '2' }] },
                      },
                  ],
              }
            : { type: 'final_answer', model: null, content: 'Fresh answer' }
    }
    state.dependencies.runTurn = async (options) => {
        const result = await runConversationTurn(options)
        if (options.task === 'Patch') {
            settled.resolve()
            await release.promise
        }
        return result
    }
    try {
        await writeFile(source, 'export const value = 1\n')
        const running = state.start()
        // Prebuffer the first task; this is the ordinary readline input path.
        stream.write('Patch\n')
        await approval.promise
        stream.write('y')
        stream.write('\x03')
        await settled.promise
        assert.ok(processInterrupt)
        processInterrupt()
        stream.write('y\n')
        stream.write('\x03')
        await tick()
        assert.equal(reads, 2)
        assert.equal(await readFile(source, 'utf8'), 'export const value = 1\n')
        release.resolve()
        await nextPrompt.promise
        stream.write('Fresh task\n/exit\n')
        const result = await running
        assert.equal(result.exitCode, 0)
        assert.equal(requests.length, 2)
        assert.deepEqual(
            requests[1]?.messages
                .filter((message) => message.role === 'user')
                .map((message) => message.content),
            ['Patch', 'Fresh task']
        )
        assert.ok(
            requests[1]?.messages.some(
                (message) => message.role === 'tool' && message.result.status === 'aborted'
            )
        )
        assert.equal(await readFile(source, 'utf8'), 'export const value = 1\n')
        assert.match(state.output[0]!, /cancelled/)
        assert.match(state.output[1]!, /Run #2 result: completed/)
        assert.equal(processSubscriptions, 1)
        assert.equal(processInterrupt, undefined)
        assert.equal(inputDisposed, 1)
    } finally {
        release.resolve()
        native.close()
        stream.destroy()
        terminal.destroy()
        await state.cleanup()
    }
})

test('idle native Ctrl+C exits without allocating a run', async () => {
    const stream = new PassThrough(),
        terminal = new PassThrough(),
        ready = deferred<void>()
    const native = createNodeLineInput({ input: stream, output: terminal, isInteractive: true })
    const state = await fixture([])
    state.dependencies.isInteractive = true
    state.dependencies.createLineInput = () => ({
        ...native,
        readLine: (prompt, options) => {
            const result = native.readLine(prompt, options)
            ready.resolve()
            return result
        },
    })
    state.dependencies.transport = async () => {
        assert.fail('idle interrupt must not call model')
    }
    try {
        const running = state.start()
        await ready.promise
        stream.write('\x03')
        assert.deepEqual(await running, { exitCode: 0, session: null })
        assert.deepEqual(state.statuses, [])
        assert.deepEqual(state.output, [])
    } finally {
        native.close()
        stream.destroy()
        terminal.destroy()
        await state.cleanup()
    }
})

for (const failure of ['turn', 'input', 'subscribe'] as const) {
    test(`${failure} failure releases input and scoped interrupt subscription`, async () => {
        const state = await fixture(['Task'])
        let inputCloses = 0
        if (failure === 'turn')
            state.dependencies.runTurn = () => {
                throw new Error('private diagnostic')
            }
        if (failure === 'input')
            state.dependencies.createLineInput = () => ({
                readLine: async () => {
                    throw new Error('private diagnostic')
                },
                close: () => {
                    inputCloses += 1
                },
            })
        if (failure === 'subscribe')
            state.dependencies.subscribeProcessInterrupt = () => {
                throw new Error('private diagnostic')
            }
        try {
            const result = await state.start()
            assert.equal(result.exitCode, 1)
            assert.equal(state.counts().disposed, failure === 'subscribe' ? 0 : 1)
            assert.equal(failure === 'input' ? inputCloses : state.counts().closes, 1)
            assert.doesNotMatch(state.errors.join(''), /private diagnostic/)
        } finally {
            await state.cleanup()
        }
    })
}

test('cancellation survives rendering, clock, and diagnostic failures', async () => {
    const entered = deferred<void>(),
        release = deferred<void>()
    const state = await fixture(['Task', '/exit'], async () => {
        entered.resolve()
        await release.promise
        return { type: 'final_answer', model: null, content: 'Late' }
    })
    state.dependencies.writeStatus =
        state.dependencies.writeOutput =
        state.dependencies.writeError =
            () => {
                throw new Error('private display failure')
            }
    state.dependencies.observationClocks = {
        wallTime: () => {
            throw new Error('clock')
        },
        monotonicTime: () => {
            throw new Error('clock')
        },
    }
    try {
        const running = state.start()
        await entered.promise
        state.interrupt()
        release.resolve()
        const result = await running
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'aborted')
        assert.equal(result.session?.stopReason, 'aborted')
        assert.deepEqual(state.answers, [])
        assert.equal(state.counts().disposed, 1)
    } finally {
        release.resolve()
        await state.cleanup()
    }
})

test('process interrupt still cancels active work after interactive readline EOF', async () => {
    const stream = new PassThrough(),
        terminal = new PassThrough()
    const native = createNodeLineInput({ input: stream, output: terminal, isInteractive: true })
    const entered = deferred<void>(),
        release = deferred<void>()
    let signal: AbortSignal | undefined
    const state = await fixture([], async (_request, options) => {
        signal = options?.signal
        entered.resolve()
        await release.promise
        return { type: 'final_answer', model: null, content: 'Late answer' }
    })
    state.dependencies.isInteractive = true
    state.dependencies.createLineInput = () => native
    try {
        const running = state.start()
        stream.write('Task\n')
        await entered.promise
        stream.end()
        await tick()
        state.interrupt()
        state.interrupt()
        assert.equal(signal?.aborted, true)
        assert.deepEqual(state.output, [])
        release.resolve()
        const result = await running
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'aborted')
        assert.equal(state.counts().disposed, 1)
    } finally {
        release.resolve()
        native.close()
        stream.destroy()
        terminal.destroy()
        await state.cleanup()
    }
})

test('default process SIGINT subscription exists only while chat owns input', async () => {
    const before = process.listeners('SIGINT')
    const entered = deferred<void>(),
        release = deferred<void>()
    const state = await fixture(['Task', '/exit'], async () => {
        entered.resolve()
        await release.promise
        return { type: 'final_answer', model: null, content: 'Done' }
    })
    delete state.dependencies.subscribeProcessInterrupt
    try {
        const running = state.start()
        await entered.promise
        assert.equal(process.listeners('SIGINT').length, before.length + 1)
        release.resolve()
        assert.equal((await running).exitCode, 0)
        assert.deepEqual(process.listeners('SIGINT'), before)
    } finally {
        release.resolve()
        await state.cleanup()
    }
})
