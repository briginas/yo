import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import { PATCH_MAX_DIFF_BYTES, PATCH_MAX_FILE_BYTES, type PatchEdit } from './patch-contracts.ts'
import {
    PatchTransformError,
    preparePatchTransform,
    type PatchTransformErrorCode,
} from './patch-transform.ts'

const bytes = (value: string): Uint8Array => Buffer.from(value, 'utf8')

const assertTransformError = (code: PatchTransformErrorCode, callback: () => unknown): void => {
    assert.throws(callback, (error: unknown) => {
        assert.ok(error instanceof PatchTransformError)
        assert.equal(error.code, code)
        return true
    })
}

describe('preparePatchTransform', () => {
    test('applies disjoint edits against one original and creates deterministic previews', () => {
        const source = 'alpha\nbeta\ngamma\n'
        const edits: readonly PatchEdit[] = [
            { oldText: 'alpha', newText: 'ALPHA' },
            { oldText: 'gamma', newText: 'GAMMA' },
        ]

        const result = preparePatchTransform(bytes(source), 'src/example.ts', edits)

        assert.equal(result.nextContent, 'ALPHA\nbeta\nGAMMA\n')
        assert.equal(result.addedLineCount, 2)
        assert.equal(result.removedLineCount, 2)
        assert.equal(result.baseHash, createHash('sha256').update(source).digest('hex'))
        assert.equal(
            result.nextHash,
            createHash('sha256').update('ALPHA\nbeta\nGAMMA\n').digest('hex')
        )
        assert.equal(
            result.diff,
            '--- src/example.ts\n+++ src/example.ts\n-alpha\n+ALPHA\n-gamma\n+GAMMA\n'
        )
        assert.match(result.unifiedPatch, /^Index: src\/example\.ts/m)
        assert.match(result.unifiedPatch, /^--- src\/example\.ts/m)
        assert.match(result.unifiedPatch, /^\+\+\+ src\/example\.ts/m)
        assert.deepEqual(result, preparePatchTransform(bytes(source), 'src/example.ts', edits))
    })

    test('supports deletion and preserves BOM and the dominant CRLF style', () => {
        const result = preparePatchTransform(bytes('\uFEFFone\r\ntwo\r\nthree\n'), 'notes.txt', [
            { oldText: 'two\n', newText: '' },
        ])

        assert.equal(result.nextContent, '\uFEFFone\r\nthree\r\n')
    })

    test('normalizes edit line endings for matching and preserves Unicode output bytes', () => {
        const result = preparePatchTransform(bytes('привет\r\nмир\r\n'), 'unicode.txt', [
            { oldText: 'привет\nмир', newText: 'hello\nworld 🌍' },
        ])

        assert.equal(result.nextContent, 'hello\r\nworld 🌍\r\n')
        assert.equal(
            result.nextHash,
            createHash('sha256').update('hello\r\nworld 🌍\r\n').digest('hex')
        )
    })

    test('rejects duplicate, missing, non-unique, overlapping, and no-op replacements', () => {
        const source = bytes('alphabet alpha beta')

        assertTransformError('duplicate_old_text', () =>
            preparePatchTransform(source, 'file.txt', [
                { oldText: 'alpha', newText: 'A' },
                { oldText: 'alpha', newText: 'B' },
            ])
        )
        assertTransformError('match_missing', () =>
            preparePatchTransform(source, 'file.txt', [{ oldText: 'missing', newText: 'x' }])
        )
        assertTransformError('match_not_unique', () =>
            preparePatchTransform(source, 'file.txt', [{ oldText: 'alpha', newText: 'A' }])
        )
        assertTransformError('overlapping_edits', () =>
            preparePatchTransform(bytes('alphabet'), 'file.txt', [
                { oldText: 'alpha', newText: 'A' },
                { oldText: 'alphabet', newText: 'B' },
            ])
        )
        assertTransformError('unchanged_output', () =>
            preparePatchTransform(source, 'file.txt', [{ oldText: 'beta', newText: 'beta' }])
        )
    })

    test('rejects invalid UTF-8, NUL bytes, and source/result size overflow', () => {
        assertTransformError('invalid_utf8', () =>
            preparePatchTransform(Uint8Array.from([0xc3, 0x28]), 'file.txt', [
                { oldText: 'x', newText: 'y' },
            ])
        )
        assertTransformError('nul_byte', () =>
            preparePatchTransform(bytes('before\0after'), 'file.txt', [
                { oldText: 'before', newText: 'x' },
            ])
        )
        assertTransformError('nul_byte', () =>
            preparePatchTransform(bytes('before'), 'file.txt', [
                { oldText: 'before', newText: '\0' },
            ])
        )
        assertTransformError('source_too_large', () =>
            preparePatchTransform(bytes('x'.repeat(PATCH_MAX_FILE_BYTES + 1)), 'file.txt', [
                { oldText: 'x', newText: 'y' },
            ])
        )
        assertTransformError('result_too_large', () =>
            preparePatchTransform(bytes('x'), 'file.txt', [
                { oldText: 'x', newText: 'y'.repeat(PATCH_MAX_FILE_BYTES + 1) },
            ])
        )
    })

    test('accepts source and result content exactly at the file byte limit', () => {
        const source = `${'x\n'.repeat((PATCH_MAX_FILE_BYTES - 2) / 2)}a\n`

        const result = preparePatchTransform(bytes(source), 'limit.txt', [
            { oldText: 'a', newText: 'b' },
        ])

        assert.equal(Buffer.byteLength(result.nextContent, 'utf8'), PATCH_MAX_FILE_BYTES)
        assert.equal(result.nextContent.at(-2), 'b')
    })

    test('rejects each complete preview when it exceeds the byte limit', () => {
        const oversizedChange = 'x'.repeat(PATCH_MAX_DIFF_BYTES)
        assertTransformError('display_diff_too_large', () =>
            preparePatchTransform(bytes('a'), 'file.txt', [
                { oldText: 'a', newText: oversizedChange },
            ])
        )

        const contextLine = 'c'.repeat(13 * 1024)
        const source = `${contextLine}\n${contextLine}\nold\n${contextLine}\n${contextLine}\n`
        assertTransformError('unified_patch_too_large', () =>
            preparePatchTransform(bytes(source), 'file.txt', [{ oldText: 'old', newText: 'new' }])
        )
    })
})
