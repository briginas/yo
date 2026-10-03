import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'

import { CHAT_PROMPT, createNodeLineInput, type LineInput } from './line-input.ts'
import { createTerminalPatchApprover, PATCH_APPROVAL_PROMPT } from './terminal-approval.ts'
import type { PatchApprovalView } from './runtime/patch-contracts.ts'

const request: PatchApprovalView = {
    id: 'proposal-1',
    relativePath: 'src/example.ts',
    baseHash: 'base-hash',
    nextHash: 'next-hash',
    diff: '--- src/example.ts\n+++ src/example.ts\n-old\n+new\n',
    unifiedPatch: 'unused',
    addedLineCount: 1,
    removedLineCount: 1,
}

const createInput = (response: string | null | Error): LineInput => ({
    readLine: async (prompt) => {
        assert.equal(prompt, PATCH_APPROVAL_PROMPT)

        if (response instanceof Error) {
            throw response
        }

        return response
    },
    close: () => undefined,
})

test('renders the complete display diff after clearing progress and accepts y or yes', async () => {
    for (const response of [' y ', 'YES']) {
        const operations: string[] = []
        const approve = createTerminalPatchApprover({
            input: createInput(response),
            write: (message) => operations.push(`write:${message}`),
            clearProgress: () => operations.push('clear'),
            isInteractive: true,
        })

        assert.equal(await approve(request), 'approved')
        assert.deepEqual(operations, [
            'clear',
            `write:Patch proposal: src/example.ts\n${request.diff}\n`,
        ])
    }
})

test('delegates the interactive prompt to Node readline', async () => {
    const input = new PassThrough()
    const outputChunks: string[] = []
    const output = new Writable({
        write(chunk, _encoding, callback) {
            outputChunks.push(chunk.toString())
            callback()
        },
    })
    const lineInput = createNodeLineInput({
        input,
        output,
        isInteractive: true,
    })
    const previewWrites: string[] = []
    const approve = createTerminalPatchApprover({
        input: lineInput,
        write: (message) => {
            previewWrites.push(message)
            output.write(message)
        },
        clearProgress: () => undefined,
        isInteractive: true,
    })

    const decision = approve(request)
    input.write('no\n')

    assert.equal(await decision, 'denied')
    assert.deepEqual(previewWrites, [`Patch proposal: src/example.ts\n${request.diff}\n`])
    assert.equal(outputChunks.join('').match(/Apply this patch\? \[y\/N\] /g)?.length, 1)
    lineInput.close()
})

test('fails closed for declined, unavailable, and non-interactive approval input', async () => {
    for (const input of [
        createInput(''),
        createInput('no'),
        createInput(null),
        createInput(new Error('failed')),
    ]) {
        const writes: string[] = []
        const approve = createTerminalPatchApprover({
            input,
            write: (message) => writes.push(message),
            clearProgress: () => undefined,
            isInteractive: true,
        })

        assert.equal(await approve(request), 'denied')
        assert.deepEqual(writes, [`Patch proposal: src/example.ts\n${request.diff}\n`])
    }

    const writes: string[] = []
    const approve = createTerminalPatchApprover({
        write: (message) => writes.push(message),
        clearProgress: () => undefined,
        isInteractive: false,
    })

    assert.equal(await approve(request), 'denied')
    assert.deepEqual(writes, [
        `Patch proposal: src/example.ts\n${request.diff}\n${PATCH_APPROVAL_PROMPT}\n`,
    ])
})

test('cancellation aborts pending approval, discards late input, and preserves fresh input ownership', async () => {
    const stream = new PassThrough()
    const input = createNodeLineInput({
        input: stream,
        output: new Writable({
            write(_c, _e, cb) {
                cb()
            },
        }),
        isInteractive: true,
    })
    const writes: string[] = []
    const approve = createTerminalPatchApprover({
        input,
        write: (message) => writes.push(message),
        clearProgress: () => undefined,
        isInteractive: true,
    })
    const controller = new AbortController()
    const decision = approve(request, { signal: controller.signal })
    stream.write('ye')
    controller.abort()
    stream.write('s\nyes\n')
    assert.equal(await decision, 'aborted')
    const nextTask = input.readChatSubmission!(CHAT_PROMPT)
    stream.write('fresh task\n')
    assert.deepEqual(await nextTask, { line: 'fresh task', windowId: 1 })
    const nextApproval = approve({ ...request, id: 'proposal-2' })
    stream.write('y\n')
    assert.equal(await nextApproval, 'approved')
    assert.equal(writes.length, 2)
    assert.equal(writes[0], `Patch proposal: src/example.ts\n${request.diff}\n`)
    input.close()
})

test('approval committed before a later cancellation stays approved', async () => {
    const controller = new AbortController()
    const approve = createTerminalPatchApprover({
        input: createInput('YES'),
        write: () => undefined,
        clearProgress: () => undefined,
        isInteractive: true,
    })
    const decision = await approve(request, { signal: controller.signal })
    controller.abort()
    assert.equal(decision, 'approved')
})

test('a late cancelled read resolving affirmative cannot approve the old proposal', async () => {
    const oldRead = Promise.withResolvers<string | null>()
    const controller = new AbortController()
    let calls = 0
    const approve = createTerminalPatchApprover({
        input: {
            readLine: async (_prompt, options) => {
                calls += 1
                if (calls === 1) {
                    assert.equal(options?.signal, controller.signal)
                    return oldRead.promise
                }
                return 'yes'
            },
            close: () => undefined,
        },
        write: () => undefined,
        clearProgress: () => undefined,
        isInteractive: true,
    })
    const old = approve(request, { signal: controller.signal })
    controller.abort()
    oldRead.resolve('y')
    assert.equal(await old, 'aborted')
    assert.equal(await approve({ ...request, id: 'fresh-proposal' }), 'approved')
})

test('typed read cancellation is aborted even without a run signal', async () => {
    const { LineReadAbortedError } = await import('./line-input.ts')
    const approve = createTerminalPatchApprover({
        input: createInput(new LineReadAbortedError()),
        write: () => undefined,
        clearProgress: () => undefined,
        isInteractive: true,
    })
    assert.equal(await approve(request), 'aborted')
})

test('pre-cancellation performs no preview or read and non-TTY never consumes approval input', async () => {
    const controller = new AbortController()
    controller.abort()
    let reads = 0
    const writes: string[] = []
    const input: LineInput = {
        readLine: async () => {
            reads += 1
            return 'yes'
        },
        close: () => undefined,
    }
    const approve = createTerminalPatchApprover({
        input,
        write: (message) => writes.push(message),
        clearProgress: () => undefined,
        isInteractive: false,
    })
    assert.equal(await approve(request, { signal: controller.signal }), 'aborted')
    assert.deepEqual(writes, [])
    assert.equal(await approve(request, { signal: new AbortController().signal }), 'denied')
    assert.equal(reads, 0)
    assert.equal(writes.length, 1)
})

test('cancellation during preview prevents an approval read', async () => {
    const controller = new AbortController()
    const approve = createTerminalPatchApprover({
        input: {
            readLine: async () => {
                assert.fail('read after cancellation')
            },
            close: () => undefined,
        },
        write: () => controller.abort(),
        clearProgress: () => undefined,
        isInteractive: true,
    })
    assert.equal(await approve(request, { signal: controller.signal }), 'aborted')
})
