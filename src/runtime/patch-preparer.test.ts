import assert from 'node:assert/strict'
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { PATCH_MAX_FILE_BYTES, type PatchEdit } from './patch-contracts.ts'
import {
    PatchPreparationError,
    preparePatchProposal,
    resolvePatchTarget,
    type PatchPreparationErrorCode,
    type PatchPreparationOperations,
} from './patch-preparer.ts'
import { PatchTransformError } from './patch-transform.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

const temporaryDirectories = new Set<string>()

const createWorkspaceFixture = async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-patch-preparer-'))
    const workspace = join(fixtureRoot, 'workspace')
    const outside = join(fixtureRoot, 'outside')

    temporaryDirectories.add(fixtureRoot)
    await Promise.all([mkdir(workspace), mkdir(outside)])

    return {
        workspaceRoot: await canonicalizeWorkspaceRoot(workspace),
        outside,
    }
}

const assertPreparationError = async (
    code: PatchPreparationErrorCode,
    callback: () => Promise<unknown>
): Promise<void> => {
    await assert.rejects(callback, (error: unknown) => {
        assert.ok(error instanceof PatchPreparationError)
        assert.equal(error.code, code)
        return true
    })
}

const oneEdit: readonly PatchEdit[] = [{ oldText: 'before', newText: 'after' }]

afterEach(async () => {
    const directories = [...temporaryDirectories]
    temporaryDirectories.clear()

    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true }))
    )
})

describe('resolvePatchTarget', () => {
    test('accepts one existing regular non-symlink file and preserves its mode', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourcePath = join(workspaceRoot, 'src', 'example.ts')
        await mkdir(join(workspaceRoot, 'src'))
        await writeFile(sourcePath, 'before\n')
        await chmod(sourcePath, 0o640)

        assert.deepEqual(await resolvePatchTarget(workspaceRoot, 'src/example.ts'), {
            absolutePath: sourcePath,
            relativePath: 'src/example.ts',
            mode: 0o640,
        })
    })

    test('rejects lexical escapes and sensitive paths before filesystem access', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()
        const outsidePath = join(outside, 'outside.ts')
        await writeFile(outsidePath, 'before\n')

        await assertPreparationError('outside_workspace', () =>
            resolvePatchTarget(workspaceRoot, '../outside/outside.ts')
        )
        await assertPreparationError('outside_workspace', () =>
            resolvePatchTarget(workspaceRoot, outsidePath)
        )
        await assertPreparationError('sensitive_path', () =>
            resolvePatchTarget(workspaceRoot, '.env.local')
        )
    })

    test('rejects every symlink, missing path, and non-regular target', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()
        const sourcePath = join(workspaceRoot, 'source.ts')
        const outsidePath = join(outside, 'outside.ts')
        await Promise.all([writeFile(sourcePath, 'before\n'), writeFile(outsidePath, 'before\n')])
        await mkdir(join(workspaceRoot, 'directory'))
        await symlink(sourcePath, join(workspaceRoot, 'internal-link.ts'))
        await symlink(outsidePath, join(workspaceRoot, 'external-link.ts'))
        await symlink(outside, join(workspaceRoot, 'external-directory'), 'dir')

        for (const path of [
            'internal-link.ts',
            'external-link.ts',
            'external-directory/outside.ts',
        ]) {
            await assertPreparationError('symlink_path', () =>
                resolvePatchTarget(workspaceRoot, path)
            )
        }
        await assertPreparationError('missing_path', () =>
            resolvePatchTarget(workspaceRoot, 'missing.ts')
        )
        await assertPreparationError('non_regular_file', () =>
            resolvePatchTarget(workspaceRoot, 'directory')
        )
    })

    test('recognizes an injected ENOENT-shaped filesystem error', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await assertPreparationError('missing_path', () =>
            resolvePatchTarget(workspaceRoot, 'missing.ts', {
                lstat: async () => {
                    throw { code: 'ENOENT' }
                },
                realpath,
                readFile: async () => new Uint8Array(),
                randomUUID: () => 'unused',
            })
        )
    })

    test('rechecks canonical workspace and sensitive-path policy after realpath', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourcePath = join(workspaceRoot, 'safe.ts')
        const sensitivePath = join(workspaceRoot, '.env')
        await Promise.all([
            writeFile(sourcePath, 'before\n'),
            writeFile(sensitivePath, 'TOKEN=x\n'),
        ])

        const canonicalSensitiveOperations: PatchPreparationOperations = {
            lstat,
            realpath: async () => sensitivePath,
            readFile: async () => new Uint8Array(),
            randomUUID: () => 'unused',
        }

        await assertPreparationError('sensitive_path', () =>
            resolvePatchTarget(workspaceRoot, 'safe.ts', canonicalSensitiveOperations)
        )
    })
})

describe('preparePatchProposal', () => {
    test('creates an immutable proposal without modifying the workspace file', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourcePath = join(workspaceRoot, 'src', 'example.ts')
        const source = 'const value = "before"\n'
        await mkdir(join(workspaceRoot, 'src'))
        await writeFile(sourcePath, source)
        await chmod(sourcePath, 0o640)

        const proposal = await preparePatchProposal(
            workspaceRoot,
            'src/example.ts',
            [{ oldText: 'before', newText: 'after' }],
            {
                lstat,
                realpath,
                readFile: async (path) => new Uint8Array(await readFile(path)),
                randomUUID: () => 'proposal-id',
            }
        )

        assert.equal(proposal.id, 'proposal-id')
        assert.equal(proposal.relativePath, 'src/example.ts')
        assert.equal(proposal.mode, 0o640)
        assert.equal(proposal.nextContent, 'const value = "after"\n')
        assert.match(proposal.diff, /-const value = "before"/)
        assert.match(proposal.unifiedPatch, /^--- src\/example\.ts/m)
        assert.equal(await readFile(sourcePath, 'utf8'), source)
        assert.ok(Object.isFrozen(proposal))
        assert.ok(Object.isFrozen(proposal.edits))
        assert.ok(Object.isFrozen(proposal.edits[0]))
        assert.throws(() => {
            ;(proposal as { nextContent: string }).nextContent = 'changed'
        }, TypeError)
        assert.throws(() => {
            ;(proposal.edits[0] as { newText: string }).newText = 'changed'
        }, TypeError)
    })

    test('enforces the bounded read and leaves an oversized source unchanged', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourcePath = join(workspaceRoot, 'large.txt')
        const source = `before${'x'.repeat(PATCH_MAX_FILE_BYTES)}`
        await writeFile(sourcePath, source)

        await assertPreparationError('source_too_large', () =>
            preparePatchProposal(workspaceRoot, 'large.txt', oneEdit)
        )
        assert.equal(await readFile(sourcePath, 'utf8'), source)
    })

    test('propagates transform rejection and sanitizes filesystem read failures', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourcePath = join(workspaceRoot, 'source.txt')
        await writeFile(sourcePath, 'before\0')

        await assert.rejects(
            preparePatchProposal(workspaceRoot, 'source.txt', oneEdit),
            (error: unknown) => error instanceof PatchTransformError && error.code === 'nul_byte'
        )

        await assertPreparationError('filesystem_error', () =>
            preparePatchProposal(workspaceRoot, 'source.txt', oneEdit, {
                lstat,
                realpath,
                readFile: async () => {
                    throw new Error('sensitive absolute path must not escape')
                },
                randomUUID: () => 'unused',
            })
        )
    })
})
