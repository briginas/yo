import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { canonicalizeWorkspaceRoot, resolveWorkspacePath } from './workspace.ts'

const temporaryDirectories = new Set<string>()

const createWorkspaceFixture = async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-workspace-'))
    const workspace = join(fixtureRoot, 'workspace')
    const outside = join(fixtureRoot, 'outside')

    temporaryDirectories.add(fixtureRoot)
    await Promise.all([mkdir(workspace), mkdir(outside)])

    return {
        workspaceRoot: await canonicalizeWorkspaceRoot(workspace),
        outside,
    }
}

afterEach(async () => {
    const directories = [...temporaryDirectories]
    temporaryDirectories.clear()

    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true }))
    )
})

describe('resolveWorkspacePath', () => {
    test('allows relative and absolute paths inside the workspace', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourceDirectory = join(workspaceRoot, 'src')
        const sourceFile = join(sourceDirectory, 'example.ts')

        await mkdir(sourceDirectory)
        await writeFile(sourceFile, 'export {}\n')

        const canonicalSourceFile = await realpath(sourceFile)
        const expectedDecision = {
            decision: 'allow',
            absolutePath: canonicalSourceFile,
            relativePath: 'src/example.ts',
        }

        assert.deepEqual(
            await resolveWorkspacePath(workspaceRoot, 'src/example.ts'),
            expectedDecision
        )
        assert.deepEqual(await resolveWorkspacePath(workspaceRoot, sourceFile), expectedDecision)
    })

    test('denies traversal and absolute paths outside the workspace', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()
        const outsideFile = join(outside, 'outside.txt')
        const expectedDecision = {
            decision: 'deny',
            reason: 'outside_workspace',
        }

        await writeFile(outsideFile, 'outside\n')

        assert.deepEqual(
            await resolveWorkspacePath(workspaceRoot, '../outside/outside.txt'),
            expectedDecision
        )
        assert.deepEqual(await resolveWorkspacePath(workspaceRoot, outsideFile), expectedDecision)
    })

    test('allows an internal symlink and returns the canonical target path', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const targetPath = join(workspaceRoot, 'target.ts')
        const linkPath = join(workspaceRoot, 'alias.ts')

        await writeFile(targetPath, 'export const value = 1\n')
        await symlink(targetPath, linkPath)

        assert.deepEqual(await resolveWorkspacePath(workspaceRoot, 'alias.ts'), {
            decision: 'allow',
            absolutePath: await realpath(targetPath),
            relativePath: 'target.ts',
        })
    })

    test('denies file and directory symlinks that escape the workspace', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()
        const outsideFile = join(outside, 'outside.txt')
        const expectedDecision = {
            decision: 'deny',
            reason: 'outside_workspace',
        }

        await writeFile(outsideFile, 'outside\n')
        await symlink(outsideFile, join(workspaceRoot, 'outside-file'))
        await symlink(outside, join(workspaceRoot, 'outside-directory'), 'dir')

        assert.deepEqual(
            await resolveWorkspacePath(workspaceRoot, 'outside-file'),
            expectedDecision
        )
        assert.deepEqual(
            await resolveWorkspacePath(workspaceRoot, 'outside-directory'),
            expectedDecision
        )
    })

    test('denies sensitive paths case-insensitively', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sensitivePaths = [
            '.ENV.local',
            '.git/config',
            '.ssh/id_ed25519',
            '.aws/credentials',
            '.gnupg/private-keys-v1.d',
            '.npmrc',
            '.pypirc',
            '.netrc',
            'credentials.json',
            'id_rsa',
            'id_dsa',
            'id_ecdsa',
            'id_ed25519',
            'certificate.KEY',
            'certificate.PEM',
            'certificate.P12',
            'certificate.PFX',
        ]

        for (const sensitivePath of sensitivePaths) {
            assert.deepEqual(await resolveWorkspacePath(workspaceRoot, sensitivePath), {
                decision: 'deny',
                reason: 'sensitive_path',
            })
        }
    })

    test('denies a safe-looking symlink to a sensitive target', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sensitivePath = join(workspaceRoot, '.env')

        await writeFile(sensitivePath, 'TOKEN=secret\n')
        await symlink(sensitivePath, join(workspaceRoot, 'config.txt'))

        assert.deepEqual(await resolveWorkspacePath(workspaceRoot, 'config.txt'), {
            decision: 'deny',
            reason: 'sensitive_path',
        })
    })

    test('preserves the filesystem error for a missing allowed path', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await assert.rejects(
            resolveWorkspacePath(workspaceRoot, 'missing.txt'),
            (error: unknown) => {
                assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
                return true
            }
        )
    })
})
