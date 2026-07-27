import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { z } from 'zod'

import type { PermissionDecision } from './permissions.ts'
import { dispatchToolCall, registerTool, type PatchDispatchOptions } from './tool-dispatcher.ts'
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
        const permissionDecisions: PermissionDecision[] = []
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
            0,
            (decision) => permissionDecisions.push(decision)
        )

        assert.equal(result.status, 'invalid_arguments')
        assert.equal(result.callId, 'invalid-call')
        assert.deepEqual(result.metadata, completeMetadata)
        assert.match(result.content, /^Invalid arguments for read_file:/)
        assert.match(result.content, /startLine:/)
        assert.match(result.content, /arguments:/)
        assert.deepEqual(permissionDecisions, [])

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
        const permissionDecisions: PermissionDecision[] = []
        assert.deepEqual(
            await dispatchToolCall(
                workspaceRoot,
                {
                    id: 'outside-call',
                    name: 'read_file',
                    arguments: { path: '../outside.txt' },
                },
                0,
                (decision) => permissionDecisions.push(decision)
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
                perToolTimeoutMs,
                (decision) => permissionDecisions.push(decision)
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
        assert.deepEqual(permissionDecisions, [
            { decision: 'deny', reason: 'outside_workspace' },
            { decision: 'deny', reason: 'sensitive_path' },
        ])
    })

    test('reports allow and unknown-tool permission decisions', async () => {
        const permissionDecisions: PermissionDecision[] = []

        await dispatchToolCall(
            workspaceRoot,
            {
                id: 'allowed-call',
                name: 'read_file',
                arguments: { path: 'src/agent.ts' },
            },
            perToolTimeoutMs,
            (decision) => permissionDecisions.push(decision)
        )
        await dispatchToolCall(
            workspaceRoot,
            {
                id: 'unknown-call',
                name: 'unknown_tool',
                arguments: null,
            },
            perToolTimeoutMs,
            (decision) => permissionDecisions.push(decision)
        )

        assert.deepEqual(permissionDecisions, [
            { decision: 'allow' },
            { decision: 'deny', reason: 'unknown_tool' },
        ])
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

    test('dispatches an approved patch with separate safe authorization and lifecycle evidence', async () => {
        const permissionDecisions: PermissionDecision[] = []
        const lifecycle: object[] = []
        let approvalRequest: Record<string, unknown> | undefined
        const options: PatchDispatchOptions = {
            approver: async (request) => {
                approvalRequest = request
                return 'approved'
            },
            onLifecycleEvent: (event) => lifecycle.push(event),
        }

        const result = await dispatchToolCall(
            workspaceRoot,
            {
                id: 'patch-call',
                name: 'propose_patch',
                arguments: {
                    path: 'src/agent.ts',
                    edits: [{ oldText: 'found', newText: 'applied' }],
                },
            },
            perToolTimeoutMs,
            (decision) => permissionDecisions.push(decision),
            options
        )

        assert.deepEqual(result, {
            status: 'success',
            callId: 'patch-call',
            content: 'Patch applied: src/agent.ts',
            metadata: completeMetadata,
        })
        assert.deepEqual(permissionDecisions, [{ decision: 'allow' }])
        assert.deepEqual(
            lifecycle.map((event) => (event as { type: string }).type),
            ['prepared', 'approval_requested', 'approval_resolved', 'applied']
        )
        for (const event of lifecycle) {
            assert.equal(JSON.stringify(event).includes('found'), false)
            assert.equal('diff' in event, false)
            assert.equal('unifiedPatch' in event, false)
            assert.equal('nextContent' in event, false)
            assert.equal('oldText' in event, false)
        }
        assert.ok(approvalRequest)
        assert.equal('nextContent' in approvalRequest, false)
        assert.equal('absolutePath' in approvalRequest, false)
        assert.equal(
            await readFile(join(workspaceRoot, 'src', 'agent.ts'), 'utf8'),
            "export const needle = 'applied'\n"
        )
    })

    test('fails closed after preparation when approval is absent, denied, or aborted', async () => {
        for (const decision of [undefined, 'denied', 'aborted'] as const) {
            const result = await dispatchToolCall(
                workspaceRoot,
                {
                    id: `patch-${decision ?? 'absent'}`,
                    name: 'propose_patch',
                    arguments: {
                        path: 'src/agent.ts',
                        edits: [{ oldText: 'found', newText: 'blocked' }],
                    },
                },
                perToolTimeoutMs,
                undefined,
                decision === undefined
                    ? {}
                    : {
                          approver: async () => decision,
                      }
            )

            assert.equal(result.callId, `patch-${decision ?? 'absent'}`)
            assert.equal(result.status, decision === 'aborted' ? 'aborted' : 'denied')
            assert.equal(
                await readFile(join(workspaceRoot, 'src', 'agent.ts'), 'utf8'),
                "export const needle = 'found'\n"
            )
        }
    })

    test('does not prepare a patch after invalid arguments or a path-policy denial', async () => {
        const permissionDecisions: PermissionDecision[] = []
        let approvalCount = 0
        const options: PatchDispatchOptions = {
            approver: async () => {
                approvalCount += 1
                return 'approved'
            },
        }

        const invalid = await dispatchToolCall(
            workspaceRoot,
            {
                id: 'invalid-patch',
                name: 'propose_patch',
                arguments: { path: 'src/agent.ts', edits: [], unexpected: true },
            },
            perToolTimeoutMs,
            (decision) => permissionDecisions.push(decision),
            options
        )
        const denied = await dispatchToolCall(
            workspaceRoot,
            {
                id: 'outside-patch',
                name: 'propose_patch',
                arguments: {
                    path: '../outside.ts',
                    edits: [{ oldText: 'found', newText: 'blocked' }],
                },
            },
            perToolTimeoutMs,
            (decision) => permissionDecisions.push(decision),
            options
        )

        assert.equal(invalid.status, 'invalid_arguments')
        assert.equal(denied.status, 'denied')
        assert.deepEqual(permissionDecisions, [{ decision: 'deny', reason: 'outside_workspace' }])
        assert.equal(approvalCount, 0)
        assert.equal(
            await readFile(join(workspaceRoot, 'src', 'agent.ts'), 'utf8'),
            "export const needle = 'found'\n"
        )
    })

    test('keeps propose_patch unknown without the controlled patch-dispatch option', async () => {
        const result = await dispatchToolCall(
            workspaceRoot,
            {
                id: 'uncontrolled-patch',
                name: 'propose_patch',
                arguments: {
                    path: 'src/agent.ts',
                    edits: [{ oldText: 'found', newText: 'blocked' }],
                },
            },
            perToolTimeoutMs
        )

        assert.equal(result.status, 'unknown_tool')
        assert.equal(
            await readFile(join(workspaceRoot, 'src', 'agent.ts'), 'utf8'),
            "export const needle = 'found'\n"
        )
    })

    test('maps conflicts, timeouts, and failures without writing an unapproved result', async () => {
        const sourcePath = join(workspaceRoot, 'src', 'agent.ts')
        const call = {
            id: 'controlled-patch',
            name: 'propose_patch',
            arguments: {
                path: 'src/agent.ts',
                edits: [{ oldText: 'found', newText: 'applied' }],
            },
        }

        const conflictEvents: object[] = []
        const conflict = await dispatchToolCall(workspaceRoot, call, perToolTimeoutMs, undefined, {
            approver: async () => {
                await writeFile(sourcePath, "export const needle = 'newer'\n")
                return 'approved'
            },
            onLifecycleEvent: (event) => conflictEvents.push(event),
        })
        assert.equal(conflict.status, 'execution_error')
        assert.equal(conflict.error?.code, 'base_changed')
        assert.deepEqual(
            conflictEvents.map((event) => (event as { type: string }).type),
            ['prepared', 'approval_requested', 'approval_resolved', 'conflicted']
        )
        assert.equal(await readFile(sourcePath, 'utf8'), "export const needle = 'newer'\n")

        await writeFile(sourcePath, "export const needle = 'found'\n")
        const timeout = await dispatchToolCall(workspaceRoot, call, perToolTimeoutMs, undefined, {
            approver: async () => 'approved',
            operations: {
                applyProposal: async () => ({ status: 'timeout' }),
            },
        })
        assert.equal(timeout.status, 'timeout')
        assert.equal(await readFile(sourcePath, 'utf8'), "export const needle = 'found'\n")

        const failed = await dispatchToolCall(workspaceRoot, call, perToolTimeoutMs, undefined, {
            approver: async () => 'approved',
            operations: {
                applyProposal: async () => {
                    throw new Error('do not expose filesystem detail')
                },
            },
        })
        assert.equal(failed.status, 'execution_error')
        assert.equal(failed.content.includes('filesystem detail'), false)
        assert.equal(await readFile(sourcePath, 'utf8'), "export const needle = 'found'\n")

        let approvalCount = 0
        const preparationTimeout = await dispatchToolCall(workspaceRoot, call, 1, undefined, {
            approver: async () => {
                approvalCount += 1
                return 'approved'
            },
            operations: {
                prepareProposal: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20))
                    throw new Error('late preparation failure')
                },
            },
        })
        assert.equal(preparationTimeout.status, 'timeout')
        assert.equal(approvalCount, 0)
        assert.equal(await readFile(sourcePath, 'utf8'), "export const needle = 'found'\n")
    })
})
