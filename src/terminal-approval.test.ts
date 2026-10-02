import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'

import { createNodeLineInput, type LineInput } from './line-input.ts'
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
