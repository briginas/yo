import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { z } from 'zod'

import { dispatchToolCall, registerTool } from './tool-dispatcher.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

const completeMetadata = {
    truncated: false,
    truncation: null,
} as const

const perToolTimeoutMs = 1_000

let fixtureRoot: string
let workspaceRoot: string

beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-tool-dispatcher-'))
    const workspace = join(fixtureRoot, 'workspace')
    const sourceDirectory = join(workspace, 'src')

    await mkdir(sourceDirectory, { recursive: true })
    await Promise.all([
        writeFile(join(workspace, 'README.md'), '# Fixture\n'),
        writeFile(join(sourceDirectory, 'agent.ts'), "export const needle = 'found'\n"),
        writeFile(join(sourceDirectory, 'other.ts'), 'export const other = true\n'),
    ])

    workspaceRoot = await canonicalizeWorkspaceRoot(workspace)
})

afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
})

describe('dispatchToolCall', () => {
    test('dispatches and normalizes each registered read-only tool', async () => {
        assert.deepEqual(
            await dispatchToolCall(
                workspaceRoot,
                {
                    id: 'list-call',
                    name: 'list_files',
                    arguments: { path: 'src', limit: 1 },
                },
                perToolTimeoutMs
            ),
            {
                status: 'success',
                callId: 'list-call',
                content: 'src/agent.ts',
                metadata: {
                    truncated: true,
                    truncation: {
                        reason: 'result_limit',
                        limit: 1,
                        observed: 2,
                    },
                },
            }
        )

        assert.deepEqual(
            await dispatchToolCall(
                workspaceRoot,
                {
                    id: 'search-call',
                    name: 'search_code',
                    arguments: { query: 'needle', path: 'src' },
                },
                perToolTimeoutMs
            ),
            {
                status: 'success',
                callId: 'search-call',
                content: "src/agent.ts:1:export const needle = 'found'",
                metadata: completeMetadata,
            }
        )

        assert.deepEqual(
            await dispatchToolCall(
                workspaceRoot,
                {
                    id: 'read-call',
                    name: 'read_file',
                    arguments: { path: 'src/agent.ts' },
                },
                perToolTimeoutMs
            ),
            {
                status: 'success',
                callId: 'read-call',
                content: "1:export const needle = 'found'",
                metadata: completeMetadata,
            }
        )
    })

    test('rejects invalid arguments before filesystem execution', async () => {
        const result = await dispatchToolCall(
            workspaceRoot,
            {
                id: 'invalid-call',
                name: 'read_file',
                arguments: {
                    path: 'missing.ts',
                    startLine: 0,
                    unexpected: true,
                },
            },
            0
        )

        assert.equal(result.status, 'invalid_arguments')
        assert.equal(result.callId, 'invalid-call')
        assert.deepEqual(result.metadata, completeMetadata)
        assert.match(result.content, /^Invalid arguments for read_file:/)
        assert.match(result.content, /startLine:/)
        assert.match(result.content, /arguments:/)

        if (result.status === 'invalid_arguments') {
            assert.deepEqual(result.error, {
                code: 'invalid_arguments',
                message: result.content,
            })
        }
    })

    test('rejects write, process, and network tool names before argument validation', async () => {
        for (const name of ['write_file', 'shell', 'fetch_url']) {
            assert.deepEqual(
                await dispatchToolCall(
                    workspaceRoot,
                    {
                        id: `${name}-call`,
                        name,
                        arguments: null,
                    },
                    perToolTimeoutMs
                ),
                {
                    status: 'unknown_tool',
                    callId: `${name}-call`,
                    content: `Unknown tool: ${name}`,
                    metadata: completeMetadata,
                    error: {
                        code: 'unknown_tool',
                        message: `Unknown tool: ${name}`,
                    },
                }
            )
        }
    })

    test('normalizes workspace and sensitive-path permission denials', async () => {
        assert.deepEqual(
            await dispatchToolCall(
                workspaceRoot,
                {
                    id: 'outside-call',
                    name: 'read_file',
                    arguments: { path: '../outside.txt' },
                },
                0
            ),
            {
                status: 'denied',
                callId: 'outside-call',
                content: 'Tool access denied: outside_workspace',
                metadata: completeMetadata,
                error: {
                    code: 'outside_workspace',
                    message: 'Tool access denied: outside_workspace',
                },
            }
        )

        assert.deepEqual(
            await dispatchToolCall(
                workspaceRoot,
                {
                    id: 'sensitive-call',
                    name: 'search_code',
                    arguments: { query: 'TOKEN', path: '.env' },
                },
                perToolTimeoutMs
            ),
            {
                status: 'denied',
                callId: 'sensitive-call',
                content: 'Tool access denied: sensitive_path',
                metadata: completeMetadata,
                error: {
                    code: 'sensitive_path',
                    message: 'Tool access denied: sensitive_path',
                },
            }
        )
    })

    test('normalizes executor failures without throwing', async () => {
        const binaryPath = join(workspaceRoot, 'binary.dat')
        await writeFile(binaryPath, Buffer.from([0, 1, 2]))

        const cases = [
            {
                id: 'missing-call',
                name: 'read_file',
                arguments: { path: 'missing.ts' },
                expectedCause: /ENOENT/,
            },
            {
                id: 'wrong-kind-call',
                name: 'list_files',
                arguments: { path: 'README.md' },
                expectedCause: /List path must be a directory: README\.md/,
            },
            {
                id: 'binary-call',
                name: 'read_file',
                arguments: { path: 'binary.dat' },
                expectedCause: /Cannot read binary file: binary\.dat/,
            },
        ]

        for (const testCase of cases) {
            const result = await dispatchToolCall(workspaceRoot, testCase, perToolTimeoutMs)

            assert.equal(result.status, 'execution_error')
            assert.equal(result.callId, testCase.id)
            assert.deepEqual(result.metadata, completeMetadata)
            assert.match(result.content, /^Tool execution failed:/)
            assert.match(result.content, testCase.expectedCause)

            if (result.status === 'execution_error') {
                assert.deepEqual(result.error, {
                    code: 'execution_error',
                    message: result.content,
                })
            }
        }
    })

    test('returns one timeout result and ignores late executor settlement', async () => {
        for (const lateSettlement of ['success', 'error'] as const) {
            const executorResult = Promise.withResolvers<{
                status: 'success'
                content: string
                metadata: typeof completeMetadata
            }>()
            let executionCount = 0
            const dispatchControlledTool = registerTool(
                z.object({ path: z.string() }).strict(),
                async () => ({
                    decision: 'allow',
                    absolutePath: workspaceRoot,
                    relativePath: '.',
                }),
                async () => {
                    executionCount += 1

                    return executorResult.promise
                }
            )

            const result = await dispatchControlledTool(
                workspaceRoot,
                {
                    id: `${lateSettlement}-after-timeout`,
                    name: 'controlled_read',
                    arguments: { path: '.' },
                },
                1
            )

            assert.deepEqual(result, {
                status: 'timeout',
                callId: `${lateSettlement}-after-timeout`,
                content: 'Tool execution timed out after 1 ms',
                metadata: completeMetadata,
                error: {
                    code: 'timeout',
                    message: 'Tool execution timed out after 1 ms',
                },
            })
            assert.equal(executionCount, 1)

            if (lateSettlement === 'success') {
                executorResult.resolve({
                    status: 'success',
                    content: 'late success',
                    metadata: completeMetadata,
                })
            } else {
                executorResult.reject(new Error('late failure'))
            }

            await new Promise<void>((resolve) => setImmediate(resolve))
            assert.equal(result.status, 'timeout')
        }
    })
})
