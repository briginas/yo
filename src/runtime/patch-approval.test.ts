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

test('pre-abort skips the approver and propagates optional signal apart from frozen proposal', async () => {
    const controller = new AbortController()
    controller.abort()
    assert.equal(
        await requestPatchApproval(
            proposal(),
            async () => {
                assert.fail('called after abort')
            },
            { signal: controller.signal }
        ),
        'aborted'
    )
    const active = new AbortController()
    assert.equal(
        await requestPatchApproval(
            proposal(),
            async (view, options) => {
                assert.equal(options?.signal, active.signal)
                assert.ok(Object.isFrozen(view))
                assert.equal('signal' in view, false)
                return 'approved'
            },
            { signal: active.signal }
        ),
        'approved'
    )
})

test('cancellation before pending consent settlement prevents a late approval or rejection', async () => {
    for (const reject of [false, true]) {
        const controller = new AbortController()
        const pending = Promise.withResolvers<'approved'>()
        const decision = requestPatchApproval(proposal(), () => pending.promise, {
            signal: controller.signal,
        })
        controller.abort()
        if (reject) pending.reject(new Error('late failure'))
        else pending.resolve('approved')
        assert.equal(await decision, 'aborted')
    }
})

test('a settled approval remains approved after later cancellation', async () => {
    const controller = new AbortController()
    const decision = await requestPatchApproval(proposal(), async () => 'approved', {
        signal: controller.signal,
    })
    controller.abort()
    assert.equal(decision, 'approved')
})
