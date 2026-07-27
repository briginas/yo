import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { LineInput } from './line-input.ts'
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
        assert.equal(prompt, '')

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
            `write:Patch proposal: src/example.ts\n${request.diff}\n${PATCH_APPROVAL_PROMPT}`,
        ])
    }
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
        assert.deepEqual(writes, [
            `Patch proposal: src/example.ts\n${request.diff}\n${PATCH_APPROVAL_PROMPT}`,
        ])
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
