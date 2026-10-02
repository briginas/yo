import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
    PATCH_MAX_ARGUMENT_BYTES,
    PATCH_MAX_EDITS,
    proposePatchArgumentsSchema,
} from './patch-contracts.ts'

type RuntimeSchema = {
    safeParse: (input: unknown) => { success: boolean }
}

const assertRejected = (schema: RuntimeSchema, inputs: unknown[]) => {
    for (const input of inputs) {
        assert.equal(
            schema.safeParse(input).success,
            false,
            `expected rejection for ${JSON.stringify(input)}`
        )
    }
}

describe('proposePatchArgumentsSchema', () => {
    test('accepts untrusted arguments at the edit and UTF-8 byte boundaries', () => {
        const untrustedArguments: unknown = {
            path: 'src/example.ts',
            edits: Array.from({ length: PATCH_MAX_EDITS }, (_, index) => ({
                oldText: `before-${index}`,
                newText: index === 0 ? '' : `after-${index}`,
            })),
        }

        assert.deepEqual(proposePatchArgumentsSchema.parse(untrustedArguments), untrustedArguments)
        assert.equal(
            proposePatchArgumentsSchema.safeParse({
                path: 'exact-limit.txt',
                edits: [{ oldText: 'x'.repeat(PATCH_MAX_ARGUMENT_BYTES), newText: '' }],
            }).success,
            true
        )
        assert.equal(
            proposePatchArgumentsSchema.safeParse({
                path: 'multibyte-limit.txt',
                edits: [{ oldText: 'é'.repeat(PATCH_MAX_ARGUMENT_BYTES / 2), newText: '' }],
            }).success,
            true
        )
    })

    test('rejects malformed, over-limit, and unknown proposal properties', () => {
        assertRejected(proposePatchArgumentsSchema, [
            null,
            [],
            { path: '' },
            { path: 'src/example.ts', edits: [] },
            { path: 'src/example.ts', edits: [{ oldText: '', newText: 'after' }] },
            { path: 'src/example.ts', edits: [{ oldText: 'before' }] },
            {
                path: 'src/example.ts',
                edits: [{ oldText: 'before', newText: 'after', extra: true }],
            },
            {
                path: 'src/example.ts',
                edits: [{ oldText: 'before', newText: 'after' }],
                extra: true,
            },
            {
                path: 'src/example.ts',
                edits: Array.from({ length: PATCH_MAX_EDITS + 1 }, () => ({
                    oldText: 'before',
                    newText: 'after',
                })),
            },
            {
                path: 'over-limit.txt',
                edits: [{ oldText: 'x'.repeat(PATCH_MAX_ARGUMENT_BYTES), newText: 'y' }],
            },
            {
                path: 'multibyte-over-limit.txt',
                edits: [{ oldText: 'é'.repeat(PATCH_MAX_ARGUMENT_BYTES / 2), newText: 'y' }],
            },
        ])
    })
})
