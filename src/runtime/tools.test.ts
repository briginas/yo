import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
    listFilesArgumentsSchema,
    readFileArgumentsSchema,
    searchCodeArgumentsSchema,
} from './tools.ts'

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

describe('listFilesArgumentsSchema', () => {
    test('accepts minimal and complete arguments', () => {
        assert.deepEqual(listFilesArgumentsSchema.parse({ path: '.' }), { path: '.' })
        assert.deepEqual(
            listFilesArgumentsSchema.parse({ path: 'src', glob: '**/*.ts', limit: 25 }),
            { path: 'src', glob: '**/*.ts', limit: 25 }
        )
    })

    test('rejects empty strings, unknown properties, and invalid limits', () => {
        assertRejected(listFilesArgumentsSchema, [
            { path: '' },
            { path: '.', glob: '' },
            { path: '.', unknown: true },
            { path: '.', limit: 0 },
            { path: '.', limit: -1 },
            { path: '.', limit: 1.5 },
        ])
    })
})

describe('searchCodeArgumentsSchema', () => {
    test('accepts minimal and complete arguments', () => {
        assert.deepEqual(searchCodeArgumentsSchema.parse({ query: 'ToolCall' }), {
            query: 'ToolCall',
        })
        assert.deepEqual(
            searchCodeArgumentsSchema.parse({
                query: 'ToolCall',
                path: 'src',
                glob: '**/*.ts',
                limit: 10,
            }),
            { query: 'ToolCall', path: 'src', glob: '**/*.ts', limit: 10 }
        )
    })

    test('rejects empty strings, unknown properties, and invalid limits', () => {
        assertRejected(searchCodeArgumentsSchema, [
            { query: '' },
            { query: 'ToolCall', path: '' },
            { query: 'ToolCall', glob: '' },
            { query: 'ToolCall', unknown: true },
            { query: 'ToolCall', limit: 0 },
            { query: 'ToolCall', limit: -1 },
            { query: 'ToolCall', limit: 1.5 },
        ])
    })
})

describe('readFileArgumentsSchema', () => {
    test('accepts minimal and complete arguments', () => {
        assert.deepEqual(readFileArgumentsSchema.parse({ path: 'src/runtime/tools.ts' }), {
            path: 'src/runtime/tools.ts',
        })
        assert.deepEqual(
            readFileArgumentsSchema.parse({
                path: 'src/runtime/tools.ts',
                startLine: 1,
                endLine: 20,
            }),
            { path: 'src/runtime/tools.ts', startLine: 1, endLine: 20 }
        )
    })

    test('rejects empty paths, unknown properties, and invalid line numbers', () => {
        assertRejected(readFileArgumentsSchema, [
            { path: '' },
            { path: 'src/runtime/tools.ts', unknown: true },
            { path: 'src/runtime/tools.ts', startLine: 0 },
            { path: 'src/runtime/tools.ts', startLine: -1 },
            { path: 'src/runtime/tools.ts', startLine: 1.5 },
            { path: 'src/runtime/tools.ts', endLine: 0 },
            { path: 'src/runtime/tools.ts', endLine: -1 },
            { path: 'src/runtime/tools.ts', endLine: 1.5 },
            { path: 'src/runtime/tools.ts', startLine: 20, endLine: 10 },
        ])
    })
})
