import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'

import { CHAT_PROMPT, createNodeLineInput, runChatInput, type LineInput } from './line-input.ts'

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
