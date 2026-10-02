import assert from 'node:assert/strict'
import { test } from 'node:test'

import { requestPatchApproval } from './patch-approval.ts'
import type { PatchProposal } from './patch-contracts.ts'

const proposal = (): PatchProposal =>
    Object.freeze({
        id: 'proposal-1',
        absolutePath: '/approved/workspace/src/example.ts',
        relativePath: 'src/example.ts',
        mode: 0o644,
        edits: Object.freeze([Object.freeze({ oldText: 'before', newText: 'after' })]),
        nextContent: 'after\n',
        baseHash: 'base-hash',
        nextHash: 'next-hash',
        diff: '-before\n+after\n',
        unifiedPatch: '--- src/example.ts\n+++ src/example.ts\n',
        addedLineCount: 1,
        removedLineCount: 1,
    })

test('returns each explicit approval decision', async () => {
    for (const expected of ['approved', 'denied', 'aborted'] as const) {
        assert.equal(await requestPatchApproval(proposal(), async () => expected), expected)
    }
})

test('fails closed when approval is unavailable or invalid', async () => {
    assert.equal(await requestPatchApproval(proposal(), undefined), 'denied')
    assert.equal(
        await requestPatchApproval(proposal(), async () => 'unexpected' as unknown as 'approved'),
        'denied'
    )
})

test('sanitizes approver failures as denials', async () => {
    assert.equal(
        await requestPatchApproval(proposal(), () => {
            throw new Error('terminal input failed')
        }),
        'denied'
    )
    assert.equal(
        await requestPatchApproval(proposal(), async () => Promise.reject(new Error('EOF'))),
        'denied'
    )
})

test('passes a detached frozen approval view without proposal internals', async () => {
    const original = proposal()
    let request: Record<string, unknown> | undefined

    const decision = await requestPatchApproval(original, async (view) => {
        request = view
        assert.ok(Object.isFrozen(view))
        assert.equal('absolutePath' in view, false)
        assert.equal('nextContent' in view, false)
        assert.throws(() => {
            ;(view as { relativePath: string }).relativePath = 'mutated.ts'
        }, TypeError)

        return 'approved'
    })

    assert.equal(decision, 'approved')
    assert.ok(request)
    assert.notEqual(request, original)
    assert.equal(original.relativePath, 'src/example.ts')
    assert.equal(original.nextContent, 'after\n')
})
