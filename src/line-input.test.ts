import assert from 'node:assert/strict'
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

    assert.equal(reason, 'exit')
    assert.deepEqual(messages, ['Inspect this.', ' /exit '])
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
