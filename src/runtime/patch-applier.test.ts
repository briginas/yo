import assert from 'node:assert/strict'
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import {
    applyPatchProposal,
    applyPatchProposalWithTimeout,
    PatchApplicationError,
    type PatchApplicationOperations,
} from './patch-applier.ts'
import { preparePatchProposal } from './patch-preparer.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

const temporaryDirectories = new Set<string>()

const createFixture = async (mode = 0o640) => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-patch-applier-'))
    const workspace = join(fixtureRoot, 'workspace')
    const sourcePath = join(workspace, 'src', 'example.ts')
    temporaryDirectories.add(fixtureRoot)
    await mkdir(join(workspace, 'src'), { recursive: true })
    await writeFile(sourcePath, '\uFEFFconst value = "before"\r\n')
    await chmod(sourcePath, mode)

    const workspaceRoot = await canonicalizeWorkspaceRoot(workspace)

    return {
        workspaceRoot,
        sourcePath: join(workspaceRoot, 'src', 'example.ts'),
    }
}

const proposalFor = async (workspaceRoot: string) =>
    preparePatchProposal(workspaceRoot, 'src/example.ts', [{ oldText: 'before', newText: 'after' }])

afterEach(async () => {
    const directories = [...temporaryDirectories]
    temporaryDirectories.clear()
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true }))
    )
})

describe('applyPatchProposal', () => {
    test('atomically applies an exact proposal while preserving mode, BOM, and line endings', async () => {
        const { workspaceRoot, sourcePath } = await createFixture(0o666)
        const proposal = await proposalFor(workspaceRoot)

        assert.deepEqual(await applyPatchProposal(workspaceRoot, proposal), { status: 'applied' })
        assert.equal(await readFile(sourcePath, 'utf8'), '\uFEFFconst value = "after"\r\n')
        assert.equal((await stat(sourcePath)).mode & 0o7777, 0o666)
    })

    test('returns conflicts without writing for stale source or altered proposal data', async () => {
        const { workspaceRoot, sourcePath } = await createFixture()
        const proposal = await proposalFor(workspaceRoot)
        await writeFile(sourcePath, '\uFEFFconst value = "newer"\r\n')

        assert.deepEqual(await applyPatchProposal(workspaceRoot, proposal), {
            status: 'conflict',
            conflict: { code: 'base_changed', message: 'Patch target changed after approval' },
        })
        assert.equal(await readFile(sourcePath, 'utf8'), '\uFEFFconst value = "newer"\r\n')

        await writeFile(sourcePath, '\uFEFFconst value = "before"\r\n')
        const alteredProposal = Object.freeze({ ...proposal, nextContent: 'unexpected' })
        assert.equal((await applyPatchProposal(workspaceRoot, alteredProposal)).status, 'conflict')
        assert.equal(await readFile(sourcePath, 'utf8'), '\uFEFFconst value = "before"\r\n')
    })

    test('reauthorizes path replacements before writing', async () => {
        const { workspaceRoot, sourcePath } = await createFixture()
        const proposal = await proposalFor(workspaceRoot)
        const replacement = join(workspaceRoot, 'replacement.ts')
        await writeFile(replacement, 'outside\n')
        await rm(sourcePath)
        await symlink(replacement, sourcePath)

        await assert.rejects(
            applyPatchProposal(workspaceRoot, proposal),
            (error: unknown) =>
                error instanceof PatchApplicationError && error.code === 'filesystem_error'
        )
        assert.equal(await readFile(replacement, 'utf8'), 'outside\n')
    })

    test('settles an abort at every temporary-file boundary, cleans up, and never renames', async () => {
        const { workspaceRoot, sourcePath } = await createFixture()
        const proposal = await proposalFor(workspaceRoot)

        for (const boundary of ['open', 'chmod', 'write', 'sync', 'close'] as const) {
            const controller = new AbortController()
            const calls: string[] = []
            const abortAt = (stage: typeof boundary) => {
                calls.push(stage)
                if (stage === boundary) {
                    controller.abort()
                }
            }
            const operations: PatchApplicationOperations = {
                resolveTarget: async () => ({
                    absolutePath: sourcePath,
                    relativePath: 'src/example.ts',
                    mode: 0o640,
                }),
                readFile: async (path) => new Uint8Array(await readFile(path)),
                openTemporaryFile: async () => {
                    abortAt('open')
                    return {
                        chmod: async () => abortAt('chmod'),
                        writeFile: async () => abortAt('write'),
                        sync: async () => abortAt('sync'),
                        close: async () => abortAt('close'),
                    }
                },
                rename: async () => {
                    calls.push('rename')
                },
                unlink: async () => {
                    calls.push('unlink')
                },
                randomUUID: () => 'temporary',
            }

            assert.deepEqual(
                await applyPatchProposal(workspaceRoot, proposal, {
                    signal: controller.signal,
                    operations,
                }),
                { status: 'aborted' }
            )
            assert.equal(calls.includes('rename'), false)
            assert.equal(calls.includes('unlink'), true)
            assert.equal(await readFile(sourcePath, 'utf8'), '\uFEFFconst value = "before"\r\n')
        }
    })

    test('sanitizes temporary-file failures and cleans up after a settled failure', async () => {
        const { workspaceRoot, sourcePath } = await createFixture()
        const proposal = await proposalFor(workspaceRoot)
        const calls: string[] = []
        const operations: PatchApplicationOperations = {
            resolveTarget: async () => ({
                absolutePath: sourcePath,
                relativePath: 'src/example.ts',
                mode: 0o640,
            }),
            readFile: async (path) => new Uint8Array(await readFile(path)),
            openTemporaryFile: async () => ({
                chmod: async () => undefined,
                writeFile: async () => {
                    throw new Error('do not expose filesystem detail')
                },
                sync: async () => undefined,
                close: async () => {
                    calls.push('close')
                },
            }),
            rename: async () => {
                calls.push('rename')
            },
            unlink: async () => {
                calls.push('unlink')
            },
            randomUUID: () => 'temporary',
        }

        await assert.rejects(
            applyPatchProposal(workspaceRoot, proposal, { operations }),
            (error: unknown) =>
                error instanceof PatchApplicationError &&
                error.message === 'Unable to apply approved patch'
        )
        assert.deepEqual(calls, ['close', 'unlink'])
        assert.equal(await readFile(sourcePath, 'utf8'), '\uFEFFconst value = "before"\r\n')
    })

    test('uses abort-and-settle timeout behavior instead of racing a later rename', async () => {
        const { workspaceRoot, sourcePath } = await createFixture()
        const proposal = await proposalFor(workspaceRoot)
        const calls: string[] = []
        const operations: PatchApplicationOperations = {
            resolveTarget: async () => ({
                absolutePath: sourcePath,
                relativePath: 'src/example.ts',
                mode: 0o640,
            }),
            readFile: async (path) => new Uint8Array(await readFile(path)),
            openTemporaryFile: async () => ({
                chmod: async () => undefined,
                writeFile: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20))
                    calls.push('write')
                },
                sync: async () => {
                    calls.push('sync')
                },
                close: async () => {
                    calls.push('close')
                },
            }),
            rename: async () => {
                calls.push('rename')
            },
            unlink: async () => {
                calls.push('unlink')
            },
            randomUUID: () => 'temporary',
        }

        assert.deepEqual(
            await applyPatchProposalWithTimeout(workspaceRoot, proposal, 1, { operations }),
            {
                status: 'timeout',
            }
        )
        assert.equal(calls.includes('rename'), false)
        if (calls.includes('write')) {
            assert.deepEqual(calls, ['write', 'close', 'unlink'])
        }
    })
})
