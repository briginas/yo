import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { test } from 'node:test'

import {
    CHAT_PROMPT,
    createNodeLineInput,
    runChatInput,
    LineReadAbortedError,
    type LineInput,
} from './line-input.ts'

type FakeLine = string | null | Error

const createFakeLineInput = (lines: readonly FakeLine[]) => {
    const prompts: string[] = []
    let closeCount = 0
    let index = 0

    const input: LineInput = {
        readLine: async (prompt) => {
            prompts.push(prompt)

            const line = lines[index]
            index += 1

            if (line instanceof Error) {
                throw line
            }

            return line ?? null
        },
        close: () => {
            closeCount += 1
        },
    }

    return {
        input,
        prompts,
        get closeCount() {
            return closeCount
        },
    }
}

test('filters blank input and exact exit locally while preserving accepted lines', async () => {
    const fixture = createFakeLineInput(['', '   ', '\t', 'Inspect this.', ' /exit ', '/exit'])
    const messages: string[] = []
    const windows: (number | undefined)[] = []
    let clearProgressCount = 0

    const reason = await runChatInput({
        input: fixture.input,
        onMessage: async (message, windowId) => {
            messages.push(message)
            windows.push(windowId)
        },
        clearProgress: () => {
            clearProgressCount += 1
        },
    })

    assert.equal(reason, 'exit')
    assert.deepEqual(messages, ['Inspect this.', ' /exit '])
    assert.deepEqual(windows, [undefined, undefined])
    assert.deepEqual(
        fixture.prompts,
        Array.from({ length: 6 }, () => CHAT_PROMPT)
    )
    assert.equal(fixture.closeCount, 1)
    assert.equal(clearProgressCount, 1)
})

test('treats EOF as clean local termination', async () => {
    const fixture = createFakeLineInput([null])
    const messages: string[] = []
    let clearProgressCount = 0

    const reason = await runChatInput({
        input: fixture.input,
        onMessage: async (message) => {
            messages.push(message)
        },
        clearProgress: () => {
            clearProgressCount += 1
        },
    })

    assert.equal(reason, 'eof')
    assert.deepEqual(messages, [])
    assert.deepEqual(fixture.prompts, [CHAT_PROMPT])
    assert.equal(fixture.closeCount, 1)
    assert.equal(clearProgressCount, 1)
})

test('cleans up and propagates input failures', async () => {
    const failure = new Error('input failed')
    const fixture = createFakeLineInput([failure])
    let clearProgressCount = 0

    await assert.rejects(
        runChatInput({
            input: fixture.input,
            onMessage: async () => undefined,
            clearProgress: () => {
                clearProgressCount += 1
            },
        }),
        failure
    )

    assert.equal(fixture.closeCount, 1)
    assert.equal(clearProgressCount, 1)
})

test('cleans up and propagates message-handler failures', async () => {
    const failure = new Error('message failed')
    const fixture = createFakeLineInput(['Inspect this.'])
    let clearProgressCount = 0

    await assert.rejects(
        runChatInput({
            input: fixture.input,
            onMessage: async () => {
                throw failure
            },
            clearProgress: () => {
                clearProgressCount += 1
            },
        }),
        failure
    )

    assert.equal(fixture.closeCount, 1)
    assert.equal(clearProgressCount, 1)
})

test('reads prompted lines from one persistent Node readline interface', async () => {
    const outputChunks: string[] = []
    const output = new Writable({
        write(chunk, _encoding, callback) {
            outputChunks.push(chunk.toString())
            callback()
        },
    })
    const input = createNodeLineInput({
        input: Readable.from(['first line\nsecond line\n']),
        output,
        isInteractive: false,
    })

    assert.equal(await input.readLine(CHAT_PROMPT), 'first line')
    assert.equal(await input.readLine(CHAT_PROMPT), 'second line')
    input.close()
    input.close()

    assert.equal(outputChunks.join(''), `${CHAT_PROMPT}${CHAT_PROMPT}`)
})

test('maps Node readline EOF to null and allows idempotent close', async () => {
    const outputChunks: string[] = []
    const output = new Writable({
        write(chunk, _encoding, callback) {
            outputChunks.push(chunk.toString())
            callback()
        },
    })
    const input = createNodeLineInput({
        input: Readable.from([]),
        output,
        isInteractive: false,
    })

    assert.equal(await input.readLine(CHAT_PROMPT), null)
    assert.equal(await input.readLine(CHAT_PROMPT), null)
    input.close()
    input.close()

    assert.equal(outputChunks.join(''), CHAT_PROMPT)
})

const nodeInputFixture = (isInteractive = false) => {
    const stream = new PassThrough()
    const output = new Writable({
        write(_chunk, _encoding, callback) {
            callback()
        },
    })
    const input = createNodeLineInput({ input: stream, output, isInteractive })
    return { stream, input }
}

test('chat input prefers supplied arrival identities and preserves local filtering', async () => {
    const submissions = [
        { line: '\t  ', windowId: 10 },
        { line: '  task\t ', windowId: 10 },
        { line: ' /exit ', windowId: 3 },
        { line: '/exit', windowId: 12 },
    ]
    const received: { line: string; windowId: number | undefined }[] = []
    let closeCount = 0
    const reason = await runChatInput({
        input: {
            readChatSubmission: async () => submissions.shift() ?? null,
            readLine: async () => {
                assert.fail('chat must use the envelope reader')
            },
            close: () => {
                closeCount += 1
            },
        },
        onMessage: async (line, windowId) => {
            received.push({ line, windowId })
        },
        clearProgress: () => undefined,
    })
    assert.equal(reason, 'exit')
    assert.deepEqual(received, [
        { line: '  task\t ', windowId: 10 },
        { line: ' /exit ', windowId: 3 },
    ])
    assert.equal(closeCount, 1)
})

test('chat input awaits settlement and carries buffered versus fresh native windows', async () => {
    for (const isInteractive of [false, true]) {
        const stream = new PassThrough()
        let promptCount = 0
        const output = new Writable({
            write(chunk, _encoding, callback) {
                if (chunk.toString() === CHAT_PROMPT) {
                    promptCount += 1
                    if (promptCount === 1) stream.write('  first  \n')
                    if (promptCount === 3) stream.write('fresh\n')
                    if (promptCount === 4) stream.write('/exit\n')
                }
                callback()
            },
        })
        const input = createNodeLineInput({ input: stream, output, isInteractive })
        const received: { line: string; windowId: number | undefined }[] = []
        let release!: () => void
        const settlement = new Promise<void>((resolve) => {
            release = resolve
        })
        let started!: () => void
        const firstStarted = new Promise<void>((resolve) => {
            started = resolve
        })
        const running = runChatInput({
            input,
            onMessage: async (line, windowId) => {
                received.push({ line, windowId })
                if (received.length === 1) {
                    started()
                    await settlement
                }
            },
            clearProgress: () => undefined,
        })
        await firstStarted
        stream.write('buffered while working\n')
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.equal(promptCount, 1)
        assert.deepEqual(received, [{ line: '  first  ', windowId: 1 }])
        release()
        assert.equal(await running, 'exit')
        assert.deepEqual(received, [
            { line: '  first  ', windowId: 1 },
            { line: 'buffered while working', windowId: 1 },
            { line: 'fresh', windowId: 3 },
        ])
    }
})

test('chat input drains native EOF envelopes including final partial text', async () => {
    for (const isInteractive of [false, true]) {
        const { stream, input } = nodeInputFixture(isInteractive)
        stream.end('  one  \n\t\n /exit \nlast partial')
        await new Promise<void>((resolve) => setImmediate(resolve))
        const received: { line: string; windowId: number | undefined }[] = []
        assert.equal(
            await runChatInput({
                input,
                onMessage: async (line, windowId) => {
                    received.push({ line, windowId })
                },
                clearProgress: () => undefined,
            }),
            'eof'
        )
        assert.deepEqual(received, [
            { line: '  one  ', windowId: 0 },
            { line: ' /exit ', windowId: 0 },
            { line: 'last partial', windowId: 0 },
        ])
    }
})

test('chat input yields the shared reader to approval without opening another window', async () => {
    for (const isInteractive of [false, true]) {
        const stream = new PassThrough()
        let chatPrompts = 0
        const output = new Writable({
            write(chunk, _encoding, callback) {
                if (chunk.toString() === CHAT_PROMPT) {
                    chatPrompts += 1
                    if (chatPrompts === 1) stream.write('task\n')
                    if (chatPrompts === 3) stream.write('/exit\n')
                }
                callback()
            },
        })
        const input = createNodeLineInput({ input: stream, output, isInteractive })
        const received: { line: string; windowId: number | undefined }[] = []
        assert.equal(
            await runChatInput({
                input,
                onMessage: async (line, windowId) => {
                    received.push({ line, windowId })
                    if (received.length === 1) {
                        const approval = input.readLine('approval> ')
                        await assert.rejects(
                            input.readChatSubmission!(CHAT_PROMPT),
                            /Input already has an owner/
                        )
                        assert.equal(chatPrompts, 1)
                        stream.write('yes\nqueued task\n')
                        assert.equal(await approval, 'yes')
                    }
                },
                clearProgress: () => undefined,
            }),
            'exit'
        )
        assert.deepEqual(received, [
            { line: 'task', windowId: 1 },
            { line: 'queued task', windowId: 1 },
        ])
    }
})

test('chat submissions preserve startup arrival identity across later prompts', async () => {
    for (const isInteractive of [false, true]) {
        const { stream, input } = nodeInputFixture(isInteractive)
        stream.write('  startup one  \nstartup two\n')

        assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
            line: '  startup one  ',
            windowId: 0,
        })
        assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
            line: 'startup two',
            windowId: 0,
        })
        const fresh = input.readChatSubmission!(CHAT_PROMPT)
        stream.write('fresh\n')
        assert.deepEqual(await fresh, { line: 'fresh', windowId: 3 })
        input.close()
    }
})

test('chat submission identity is assigned at arrival and retained during active work', async () => {
    for (const isInteractive of [false, true]) {
        const { stream, input } = nodeInputFixture(isInteractive)
        const first = input.readChatSubmission!(CHAT_PROMPT)
        stream.write('/rerun 1\n /rerun\t1 \n')
        assert.deepEqual(await first, { line: '/rerun 1', windowId: 1 })
        stream.write('during work\n')

        assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
            line: ' /rerun\t1 ',
            windowId: 1,
        })
        stream.write('after next prompt\n')
        assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
            line: 'during work',
            windowId: 1,
        })
        assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
            line: 'after next prompt',
            windowId: 2,
        })

        const fresh = input.readChatSubmission!(CHAT_PROMPT)
        stream.write('/rerun 1\n')
        assert.deepEqual(await fresh, { line: '/rerun 1', windowId: 5 })
        input.close()
    }
})

test('approval and chat share ownership while only chat reads advance arrival windows', async () => {
    const { stream, input } = nodeInputFixture()
    const first = input.readChatSubmission!(CHAT_PROMPT)
    await assert.rejects(input.readLine('approval> '), /Input already has an owner/)
    stream.write('task\nyes\n')
    assert.deepEqual(await first, { line: 'task', windowId: 1 })
    assert.equal(await input.readLine('approval> '), 'yes')

    const approval = input.readLine('approval> ')
    await assert.rejects(input.readChatSubmission!(CHAT_PROMPT), /Input already has an owner/)
    stream.write('/rerun 1\n')
    assert.equal(await approval, '/rerun 1')
    stream.write('while working\n')
    assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
        line: 'while working',
        windowId: 1,
    })

    const fresh = input.readChatSubmission!(CHAT_PROMPT)
    stream.write('fresh\n')
    assert.deepEqual(await fresh, { line: 'fresh', windowId: 3 })
    input.close()
})

test('chat window opens before synchronous input received while writing its prompt', async () => {
    const stream = new PassThrough()
    let promptCount = 0
    const output = new Writable({
        write(_chunk, _encoding, callback) {
            promptCount += 1
            if (promptCount === 1) stream.write('during prompt\nsecond in batch\n')
            if (promptCount === 3) stream.write('fresh prompt\n')
            callback()
        },
    })
    const input = createNodeLineInput({ input: stream, output, isInteractive: false })
    assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
        line: 'during prompt',
        windowId: 1,
    })
    assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
        line: 'second in batch',
        windowId: 1,
    })
    assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
        line: 'fresh prompt',
        windowId: 3,
    })
    input.close()
})

test('input received during a prompt does not overtake previously buffered submissions', async () => {
    const stream = new PassThrough()
    let prompted = false
    const output = new Writable({
        write(_chunk, _encoding, callback) {
            if (!prompted) {
                prompted = true
                stream.write('prompt arrival\n')
            }
            callback()
        },
    })
    const input = createNodeLineInput({ input: stream, output, isInteractive: false })
    stream.write('startup arrival\n')
    assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
        line: 'startup arrival',
        windowId: 0,
    })
    assert.deepEqual(await input.readChatSubmission!(CHAT_PROMPT), {
        line: 'prompt arrival',
        windowId: 1,
    })
    input.close()
})

test('cancellation releases read ownership and discards partial and later buffered input', async () => {
    for (const isInteractive of [false, true]) {
        const { stream, input } = nodeInputFixture(isInteractive)
        const controller = new AbortController()
        const old = input.readLine('approve> ', { signal: controller.signal })
        const rejected = assert.rejects(old, LineReadAbortedError)
        stream.write('old partial')
        controller.abort()
        stream.write('y\nlate task\nduring partial')
        await rejected
        const fresh = input.readLine(CHAT_PROMPT)
        stream.write('y\n')
        assert.equal(await fresh, 'y')
        const next = input.readLine(CHAT_PROMPT)
        stream.write('fresh task\n')
        assert.equal(await next, 'fresh task')
        input.close()
    }
})

test('a resolved owner removes its abort listener and cannot cancel the next read', async () => {
    const { stream, input } = nodeInputFixture()
    const controller = new AbortController()
    const first = input.readLine('first> ', { signal: controller.signal })
    stream.write('accepted\n')
    assert.equal(await first, 'accepted')
    const second = input.readLine('next> ')
    controller.abort()
    stream.write('next line\n')
    assert.equal(await second, 'next line')
    input.close()
})

test('pre-abort does not open a prompt and overlapping read cannot steal ownership', async () => {
    const { stream, input } = nodeInputFixture()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
        input.readLine('old> ', { signal: controller.signal }),
        LineReadAbortedError
    )
    const first = input.readLine('first> ')
    await assert.rejects(input.readLine('second> '), /Input already has an owner/)
    stream.write('owned\n')
    assert.equal(await first, 'owned')
    input.close()
})

test('EOF drains ordinary buffered lines including the final partial line', async () => {
    const { stream, input } = nodeInputFixture()
    stream.end('one\ntwo\nlast partial')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(await input.readLine(CHAT_PROMPT), 'one')
    assert.equal(await input.readLine(CHAT_PROMPT), 'two')
    assert.equal(await input.readLine(CHAT_PROMPT), 'last partial')
    assert.equal(await input.readLine(CHAT_PROMPT), null)
    input.close()
})

test('close releases pending input and disposes readline input listeners', async () => {
    const { stream, input } = nodeInputFixture()
    const pending = input.readLine(CHAT_PROMPT)
    input.close()
    input.close()
    assert.equal(await pending, null)
    assert.equal(await input.readLine(CHAT_PROMPT), null)
    assert.equal(stream.listenerCount('data'), 0)
    assert.equal(stream.listenerCount('error'), 0)
})

test('input errors reject the owner and are retained until explicit close', async () => {
    const { stream, input } = nodeInputFixture()
    const failure = new Error('input failure')
    const pending = assert.rejects(input.readLine(CHAT_PROMPT), failure)
    stream.emit('error', failure)
    await pending
    await assert.rejects(input.readLine(CHAT_PROMPT), failure)
    assert.equal(stream.listenerCount('data'), 0)
    input.close()
})

test('interactive interrupts use readline separately from text and unsubscribe cleanly', async () => {
    const { stream, input } = nodeInputFixture(true)
    let count = 0
    const dispose = input.subscribeInterrupt!(() => {
        count += 1
    })
    const pending = input.readLine(CHAT_PROMPT)
    stream.write('\x03')
    assert.equal(count, 1)
    dispose()
    dispose()
    stream.write('fresh\n')
    assert.equal(await pending, 'fresh')
    const idle = input.readLine(CHAT_PROMPT)
    stream.write('\x03')
    assert.equal(count, 1)
    assert.equal(await idle, null)
    input.close()
    input.subscribeInterrupt!(() => {
        count += 1
    })()
    stream.write('\x03')
    assert.equal(count, 1)
})

test('interactive cancellation clears both sides of a moved cursor', async () => {
    const previousTerm = process.env.TERM
    process.env.TERM = 'xterm'
    let fixture: ReturnType<typeof nodeInputFixture>
    try {
        fixture = nodeInputFixture(true)
    } finally {
        if (previousTerm === undefined) delete process.env.TERM
        else process.env.TERM = previousTerm
    }
    const { stream, input } = fixture
    const controller = new AbortController()
    const old = assert.rejects(
        input.readLine('approval> ', { signal: controller.signal }),
        LineReadAbortedError
    )
    stream.write('xy\x1b[D')
    controller.abort()
    await old
    stream.write('latey\x1b[D')
    const next = input.readLine(CHAT_PROMPT)
    stream.write('fresh\n')
    assert.equal(await next, 'fresh')
    input.close()
})

test('throwing interrupt subscribers cannot block another listener or reader cleanup', async () => {
    const { stream, input } = nodeInputFixture(true)
    input.subscribeInterrupt!(() => {
        throw new Error('observer failure')
    })
    const controller = new AbortController()
    input.subscribeInterrupt!(() => controller.abort())
    const pending = assert.rejects(
        input.readLine('approval> ', { signal: controller.signal }),
        LineReadAbortedError
    )
    stream.write('\x03')
    await pending
    input.close()
    assert.equal(stream.listenerCount('keypress'), 0)
})

test('display failure during input reset cannot leave the cancelled read pending', async () => {
    const stream = new PassThrough()
    let throwing = false
    const output = new Writable({
        write(_chunk, _encoding, callback) {
            if (throwing) throw new Error('display failure')
            callback()
        },
    })
    const input = createNodeLineInput({ input: stream, output, isInteractive: true })
    const controller = new AbortController()
    const pending = assert.rejects(
        input.readLine('approval> ', { signal: controller.signal }),
        LineReadAbortedError
    )
    stream.write('old partial')
    throwing = true
    controller.abort()
    await pending
    await assert.rejects(input.readLine(CHAT_PROMPT), /Input reset failed/)
    input.close()
})

test('active cancellation discards input without opening an approval read', async () => {
    for (const isInteractive of [false, true]) {
        const { stream, input } = nodeInputFixture(isInteractive)
        const task = input.readLine(CHAT_PROMPT)
        stream.write('accepted task\n')
        assert.equal(await task, 'accepted task')
        stream.write('queued task\nold partial')
        input.discardUntilNextRead!()
        input.discardUntilNextRead!()
        stream.write('late task\nlate partial')
        const fresh = input.readLine(CHAT_PROMPT)
        stream.write('fresh task\n')
        assert.equal(await fresh, 'fresh task')
        input.close()
    }
})

test('discard releases a pending owner and clears queued input even after EOF', async () => {
    const { stream, input } = nodeInputFixture()
    const pending = input.readLine('approve> ')
    const rejected = assert.rejects(pending, LineReadAbortedError)
    input.discardUntilNextRead!()
    await rejected
    stream.end('discarded\npartial')
    await new Promise<void>((done) => setImmediate(done))
    assert.equal(await input.readLine(CHAT_PROMPT), null)
    input.close()

    const ended = nodeInputFixture()
    ended.stream.end('buffered\npartial')
    await new Promise<void>((done) => setImmediate(done))
    ended.input.discardUntilNextRead!()
    assert.equal(await ended.input.readLine(CHAT_PROMPT), null)
    ended.input.close()
})

test('cancelled chat reads discard partial text and late envelopes before fresh shared reads', async () => {
    for (const isInteractive of [false, true]) {
        const { stream, input } = nodeInputFixture(isInteractive)
        const controller = new AbortController()
        const cancelled = assert.rejects(
            input.readChatSubmission!(CHAT_PROMPT, { signal: controller.signal }),
            LineReadAbortedError
        )
        stream.write('old partial')
        controller.abort()
        stream.write('\nlate task\nlate partial')
        await cancelled
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0)

        const fresh = input.readChatSubmission!(CHAT_PROMPT)
        await assert.rejects(input.readLine('approval> '), /Input already has an owner/)
        stream.write('  fresh task  \n')
        assert.deepEqual(await fresh, { line: '  fresh task  ', windowId: 2 })
        const approval = input.readLine('approval> ')
        stream.write('yes\n')
        assert.equal(await approval, 'yes')
        const next = input.readChatSubmission!(CHAT_PROMPT)
        stream.write('next task\n')
        assert.deepEqual(await next, { line: 'next task', windowId: 3 })
        input.close()
    }
})

test('active cancellation clears buffered envelopes and partial text without another input owner', async () => {
    for (const isInteractive of [false, true]) {
        const { stream, input } = nodeInputFixture(isInteractive)
        const accepted = input.readChatSubmission!(CHAT_PROMPT)
        stream.write('task\nqueued task\nold partial')
        assert.deepEqual(await accepted, { line: 'task', windowId: 1 })
        input.discardUntilNextRead!()
        input.discardUntilNextRead!()
        stream.write('\nlate task\nlate partial')
        const fresh = input.readChatSubmission!(CHAT_PROMPT)
        stream.write('fresh\n')
        assert.deepEqual(await fresh, { line: 'fresh', windowId: 2 })
        stream.end('queued after recovery\nfinal partial')
        await new Promise<void>((resolve) => setImmediate(resolve))
        input.discardUntilNextRead!()
        assert.equal(await input.readChatSubmission!(CHAT_PROMPT), null)
        assert.equal(await input.readLine('approval> '), null)
        input.close()
    }
})

test('settled chat and approval owners cannot cancel each other through old signals', async () => {
    for (const isInteractive of [false, true]) {
        const { stream, input } = nodeInputFixture(isInteractive)
        const chatController = new AbortController()
        const chat = input.readChatSubmission!(CHAT_PROMPT, { signal: chatController.signal })
        stream.write('task\n')
        assert.deepEqual(await chat, { line: 'task', windowId: 1 })
        assert.equal(getEventListeners(chatController.signal, 'abort').length, 0)

        const approvalController = new AbortController()
        const approval = input.readLine('approval> ', { signal: approvalController.signal })
        chatController.abort()
        stream.write('yes\n')
        assert.equal(await approval, 'yes')
        assert.equal(getEventListeners(approvalController.signal, 'abort').length, 0)
        const nextChat = input.readChatSubmission!(CHAT_PROMPT)
        approvalController.abort()
        stream.write('fresh\n')
        assert.deepEqual(await nextChat, { line: 'fresh', windowId: 2 })
        input.close()
    }
})

test('input failure releases envelope ownership and removes buffered or partial submissions', async () => {
    for (const isInteractive of [false, true]) {
        for (const hasPendingOwner of [false, true]) {
            const { stream, input } = nodeInputFixture(isInteractive)
            const controller = new AbortController()
            const failure = new Error('native input failure')
            const pending = hasPendingOwner
                ? assert.rejects(
                      input.readChatSubmission!(CHAT_PROMPT, { signal: controller.signal }),
                      failure
                  )
                : undefined
            stream.write(hasPendingOwner ? 'partial' : 'buffered task\npartial')
            stream.emit('error', failure)
            await pending
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
            await assert.rejects(input.readChatSubmission!(CHAT_PROMPT), failure)
            await assert.rejects(input.readLine('approval> '), failure)
            assert.equal(stream.listenerCount(isInteractive ? 'keypress' : 'data'), 0)
            assert.equal(stream.listenerCount('error'), 0)
            input.close()
            assert.equal(await input.readChatSubmission!(CHAT_PROMPT), null)
        }
    }
})

test('explicit close settles envelope ownership and drops buffered and partial submissions', async () => {
    for (const isInteractive of [false, true]) {
        for (const hasPendingOwner of [false, true]) {
            const { stream, input } = nodeInputFixture(isInteractive)
            const controller = new AbortController()
            const pending = hasPendingOwner
                ? input.readChatSubmission!(CHAT_PROMPT, { signal: controller.signal })
                : undefined
            stream.write(hasPendingOwner ? 'partial' : 'buffered task\npartial')
            input.close()
            input.close()
            if (pending !== undefined) assert.equal(await pending, null)
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
            controller.abort()
            stream.write('\nlate task\n')
            assert.equal(await input.readChatSubmission!(CHAT_PROMPT), null)
            assert.equal(await input.readLine('approval> '), null)
            assert.equal(stream.listenerCount(isInteractive ? 'keypress' : 'data'), 0)
            assert.equal(stream.listenerCount('error'), 0)
        }
    }
})
