import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { canonicalizeWorkspaceRoot, listFiles, readFile, searchCode } from './index.ts'

test('exports and runs the basic read-only filesystem flow', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-runtime-flow-'))
    const workspace = join(fixtureRoot, 'workspace')
    const sourceDirectory = join(workspace, 'src')

    try {
        await mkdir(sourceDirectory, { recursive: true })
        await writeFile(
            join(sourceDirectory, 'agent.ts'),
            "const task = 'inspect'\nexport const needle = task\n"
        )

        const workspaceRoot = await canonicalizeWorkspaceRoot(workspace)

        assert.deepEqual(await listFiles(workspaceRoot, { path: '.' }), {
            status: 'success',
            entries: ['src/'],
        })
        assert.deepEqual(await searchCode(workspaceRoot, { query: 'needle', path: 'src' }), {
            status: 'success',
            matches: ['src/agent.ts:2:export const needle = task'],
        })
        assert.deepEqual(
            await readFile(workspaceRoot, {
                path: 'src/agent.ts',
                startLine: 2,
                endLine: 2,
            }),
            {
                status: 'success',
                content: '2:export const needle = task',
            }
        )
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})
