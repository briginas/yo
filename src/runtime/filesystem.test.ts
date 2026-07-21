import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { LIST_FILES_DEFAULT_LIMIT, SEARCH_CODE_DEFAULT_LIMIT } from './filesystem-limits.ts'
import { listFiles, readFile, searchCode } from './filesystem.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

const temporaryDirectories = new Set<string>()

const createWorkspaceFixture = async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-list-files-'))
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

describe('listFiles', () => {
    test('lists immediate entries as sorted workspace-relative paths', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await Promise.all([
            mkdir(join(workspaceRoot, 'src')),
            writeFile(join(workspaceRoot, '.editorconfig'), 'root = true\n'),
            writeFile(join(workspaceRoot, 'Alpha.ts'), 'export {}\n'),
            writeFile(join(workspaceRoot, 'beta.ts'), 'export {}\n'),
        ])

        assert.deepEqual(await listFiles(workspaceRoot, { path: '.' }), {
            status: 'success',
            entries: ['.editorconfig', 'Alpha.ts', 'beta.ts', 'src/'],
        })
    })

    test('matches recursive globs relative to the requested directory', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourceDirectory = join(workspaceRoot, 'src')

        await mkdir(join(sourceDirectory, 'nested'), { recursive: true })
        await Promise.all([
            writeFile(join(sourceDirectory, 'example.ts'), 'export {}\n'),
            writeFile(join(sourceDirectory, 'nested', 'nested.ts'), 'export {}\n'),
            writeFile(join(sourceDirectory, 'nested', 'README.md'), '# Nested\n'),
        ])

        assert.deepEqual(
            await listFiles(workspaceRoot, {
                path: 'src',
                glob: 'nested/*.ts',
            }),
            {
                status: 'success',
                entries: ['src/nested/nested.ts'],
            }
        )
    })

    test('applies the requested limit after sorting', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await Promise.all([
            writeFile(join(workspaceRoot, 'zeta.ts'), 'export {}\n'),
            writeFile(join(workspaceRoot, 'alpha.ts'), 'export {}\n'),
            writeFile(join(workspaceRoot, 'middle.ts'), 'export {}\n'),
        ])

        assert.deepEqual(await listFiles(workspaceRoot, { path: '.', limit: 2 }), {
            status: 'success',
            entries: ['alpha.ts', 'middle.ts'],
        })
    })

    test('applies the default limit when limit is omitted', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const fileNames = Array.from(
            { length: LIST_FILES_DEFAULT_LIMIT + 1 },
            (_, index) => `entry-${index.toString().padStart(3, '0')}.txt`
        )

        await Promise.all(
            fileNames.map((fileName) => writeFile(join(workspaceRoot, fileName), 'content\n'))
        )

        const result = await listFiles(workspaceRoot, { path: '.' })

        assert.equal(result.status, 'success')

        if (result.status === 'success') {
            assert.equal(result.entries.length, LIST_FILES_DEFAULT_LIMIT)
            assert.equal(result.entries.at(-1), 'entry-499.txt')
        }
    })

    test('omits sensitive paths, node_modules, and symlink entries', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()
        const sourceDirectory = join(workspaceRoot, 'source')
        const safeFile = join(workspaceRoot, 'safe.txt')

        await Promise.all([
            mkdir(sourceDirectory),
            mkdir(join(workspaceRoot, '.git')),
            mkdir(join(workspaceRoot, 'node_modules')),
            writeFile(join(workspaceRoot, '.env'), 'TOKEN=secret\n'),
            writeFile(safeFile, 'safe\n'),
        ])
        await Promise.all([
            symlink(safeFile, join(workspaceRoot, 'safe-link.txt')),
            symlink(sourceDirectory, join(workspaceRoot, 'source-link'), 'dir'),
            symlink(outside, join(workspaceRoot, 'outside-link'), 'dir'),
        ])

        assert.deepEqual(await listFiles(workspaceRoot, { path: '.' }), {
            status: 'success',
            entries: ['safe.txt', 'source/'],
        })
    })

    test('returns permission denials for a forbidden source path', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()

        await mkdir(join(workspaceRoot, '.git'))

        assert.deepEqual(await listFiles(workspaceRoot, { path: '.git' }), {
            status: 'denied',
            reason: 'sensitive_path',
        })
        assert.deepEqual(await listFiles(workspaceRoot, { path: outside }), {
            status: 'denied',
            reason: 'outside_workspace',
        })
    })

    test('rejects a source path that is not a directory', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await writeFile(join(workspaceRoot, 'file.txt'), 'content\n')

        await assert.rejects(
            listFiles(workspaceRoot, { path: 'file.txt' }),
            /List path must be a directory: file\.txt/
        )
    })
})

describe('searchCode', () => {
    test('finds literal matches recursively with workspace-relative paths and line numbers', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourceDirectory = join(workspaceRoot, 'src')

        await mkdir(join(sourceDirectory, 'nested'), { recursive: true })
        await Promise.all([
            writeFile(join(sourceDirectory, 'alpha.ts'), 'const needle = 1\r\nconst other = 2\r\n'),
            writeFile(join(sourceDirectory, 'nested', 'beta.ts'), 'needle first\nneedle second\n'),
        ])

        assert.deepEqual(await searchCode(workspaceRoot, { query: 'needle', path: 'src' }), {
            status: 'success',
            matches: [
                'src/alpha.ts:1:const needle = 1',
                'src/nested/beta.ts:1:needle first',
                'src/nested/beta.ts:2:needle second',
            ],
        })
    })

    test('supports glob filtering relative to a directory and direct-file search', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const sourceDirectory = join(workspaceRoot, 'src')

        await mkdir(join(sourceDirectory, 'nested'), { recursive: true })
        await Promise.all([
            writeFile(join(sourceDirectory, 'app.ts'), 'find me\n'),
            writeFile(join(sourceDirectory, 'notes.md'), 'find me\n'),
            writeFile(join(sourceDirectory, 'nested', 'nested.ts'), 'find me\n'),
        ])

        assert.deepEqual(
            await searchCode(workspaceRoot, {
                query: 'find me',
                path: 'src',
                glob: '*.ts',
            }),
            {
                status: 'success',
                matches: ['src/app.ts:1:find me'],
            }
        )
        assert.deepEqual(
            await searchCode(workspaceRoot, {
                query: 'find me',
                path: 'src/nested/nested.ts',
                glob: '*.ts',
            }),
            {
                status: 'success',
                matches: ['src/nested/nested.ts:1:find me'],
            }
        )
    })

    test('uses literal case-sensitive matching and applies limit in stable path order', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await Promise.all([
            writeFile(join(workspaceRoot, 'zeta.ts'), 'needle.* in zeta\nneedle.* second zeta\n'),
            writeFile(
                join(workspaceRoot, 'alpha.ts'),
                'Needle.* wrong case\nneedle wildcard text\nneedle.* literal\n'
            ),
        ])

        assert.deepEqual(
            await searchCode(workspaceRoot, {
                query: 'needle.*',
                limit: 2,
            }),
            {
                status: 'success',
                matches: ['alpha.ts:3:needle.* literal', 'zeta.ts:1:needle.* in zeta'],
            }
        )
    })

    test('applies the default limit when limit is omitted', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()
        const lines = Array.from(
            { length: SEARCH_CODE_DEFAULT_LIMIT + 1 },
            (_, index) => `needle ${index + 1}`
        )

        await writeFile(join(workspaceRoot, 'matches.txt'), `${lines.join('\n')}\n`)

        const result = await searchCode(workspaceRoot, { query: 'needle' })

        assert.equal(result.status, 'success')

        if (result.status === 'success') {
            assert.equal(result.matches.length, SEARCH_CODE_DEFAULT_LIMIT)
            assert.equal(result.matches.at(-1), 'matches.txt:100:needle 100')
        }
    })

    test('skips sensitive paths, node_modules, symlinks, and non-text files', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()
        const safeFile = join(workspaceRoot, 'safe.txt')

        await Promise.all([
            mkdir(join(workspaceRoot, '.git')),
            mkdir(join(workspaceRoot, 'node_modules')),
        ])
        await Promise.all([
            writeFile(safeFile, 'target value\n'),
            writeFile(join(workspaceRoot, '.env'), 'target secret\n'),
            writeFile(join(workspaceRoot, '.git', 'config'), 'target secret\n'),
            writeFile(join(workspaceRoot, 'node_modules', 'package.js'), 'target dependency\n'),
            writeFile(
                join(workspaceRoot, 'binary.bin'),
                Buffer.from([0, 116, 97, 114, 103, 101, 116])
            ),
            writeFile(
                join(workspaceRoot, 'invalid.txt'),
                Buffer.from([0xc3, 0x28, 116, 97, 114, 103, 101, 116])
            ),
        ])
        await Promise.all([
            symlink(safeFile, join(workspaceRoot, 'safe-link.txt')),
            symlink(outside, join(workspaceRoot, 'outside-link'), 'dir'),
        ])

        assert.deepEqual(await searchCode(workspaceRoot, { query: 'target' }), {
            status: 'success',
            matches: ['safe.txt:1:target value'],
        })
    })

    test('returns permission denials for a forbidden search path', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()

        await mkdir(join(workspaceRoot, '.git'))

        assert.deepEqual(await searchCode(workspaceRoot, { query: 'value', path: '.git' }), {
            status: 'denied',
            reason: 'sensitive_path',
        })
        assert.deepEqual(await searchCode(workspaceRoot, { query: 'value', path: outside }), {
            status: 'denied',
            reason: 'outside_workspace',
        })
    })
})

describe('readFile', () => {
    test('reads a complete UTF-8 file with normalized line endings and line numbers', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await writeFile(join(workspaceRoot, 'example.txt'), 'first\r\nsecond\rthird\r\n')

        assert.deepEqual(await readFile(workspaceRoot, { path: 'example.txt' }), {
            status: 'success',
            content: '1:first\n2:second\n3:third',
        })
    })

    test('supports inclusive start and end line ranges', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await writeFile(join(workspaceRoot, 'example.txt'), 'one\ntwo\nthree\nfour\n')

        assert.deepEqual(await readFile(workspaceRoot, { path: 'example.txt', startLine: 3 }), {
            status: 'success',
            content: '3:three\n4:four',
        })
        assert.deepEqual(await readFile(workspaceRoot, { path: 'example.txt', endLine: 2 }), {
            status: 'success',
            content: '1:one\n2:two',
        })
        assert.deepEqual(
            await readFile(workspaceRoot, {
                path: 'example.txt',
                startLine: 2,
                endLine: 3,
            }),
            {
                status: 'success',
                content: '2:two\n3:three',
            }
        )
        assert.deepEqual(await readFile(workspaceRoot, { path: 'example.txt', endLine: 20 }), {
            status: 'success',
            content: '1:one\n2:two\n3:three\n4:four',
        })
    })

    test('reads an empty file as empty content', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await writeFile(join(workspaceRoot, 'empty.txt'), '')

        assert.deepEqual(await readFile(workspaceRoot, { path: 'empty.txt' }), {
            status: 'success',
            content: '',
        })
        await assert.rejects(
            readFile(workspaceRoot, { path: 'empty.txt', startLine: 2 }),
            /Start line 2 is beyond end of file \(0 lines\): empty\.txt/
        )
    })

    test('returns permission denials for sensitive and outside-workspace paths', async () => {
        const { workspaceRoot, outside } = await createWorkspaceFixture()
        const outsideFile = join(outside, 'outside.txt')

        await Promise.all([
            writeFile(join(workspaceRoot, '.env'), 'TOKEN=secret\n'),
            writeFile(outsideFile, 'outside\n'),
        ])
        await symlink(outsideFile, join(workspaceRoot, 'outside-link.txt'))

        assert.deepEqual(await readFile(workspaceRoot, { path: '.env' }), {
            status: 'denied',
            reason: 'sensitive_path',
        })
        assert.deepEqual(await readFile(workspaceRoot, { path: outsideFile }), {
            status: 'denied',
            reason: 'outside_workspace',
        })
        assert.deepEqual(await readFile(workspaceRoot, { path: 'outside-link.txt' }), {
            status: 'denied',
            reason: 'outside_workspace',
        })
    })

    test('rejects directories and start lines beyond the file', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await mkdir(join(workspaceRoot, 'directory'))
        await writeFile(join(workspaceRoot, 'example.txt'), 'one\ntwo\n')

        await assert.rejects(
            readFile(workspaceRoot, { path: 'directory' }),
            /Read path must be a file: directory/
        )
        await assert.rejects(
            readFile(workspaceRoot, { path: 'example.txt', startLine: 3 }),
            /Start line 3 is beyond end of file \(2 lines\): example\.txt/
        )
    })

    test('rejects binary files and invalid UTF-8', async () => {
        const { workspaceRoot } = await createWorkspaceFixture()

        await Promise.all([
            writeFile(join(workspaceRoot, 'binary.bin'), Buffer.from([0, 1, 2, 3])),
            writeFile(join(workspaceRoot, 'invalid.txt'), Buffer.from([0xc3, 0x28])),
        ])

        await assert.rejects(
            readFile(workspaceRoot, { path: 'binary.bin' }),
            /Cannot read binary file: binary\.bin/
        )
        await assert.rejects(
            readFile(workspaceRoot, { path: 'invalid.txt' }),
            /Cannot decode file as UTF-8: invalid\.txt/
        )
    })
})
