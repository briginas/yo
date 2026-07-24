import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)

test('exposes the bundled entrypoint as the yo executable', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
        bin?: Record<string, string>
    }
    const source = await readFile('src/cli.ts', 'utf8')

    assert.deepEqual(packageJson.bin, {
        yo: 'dist/cli.js',
    })
    assert.ok(source.startsWith('#!/usr/bin/env node\n'))
})

test('production entrypoint reaches the Codex transport without a real credential or request', async (t) => {
    const temporaryHome = await mkdtemp(`${tmpdir()}/yo-cli-home-`)

    t.after(() => rm(temporaryHome, { recursive: true, force: true }))

    await assert.rejects(
        execFileAsync(
            process.execPath,
            ['src/cli.ts', 'ask', 'Inspect the workspace.', '--cwd', '.'],
            {
                env: {
                    ...process.env,
                    HOME: temporaryHome,
                },
            }
        ),
        (error: unknown) => {
            assert.ok(error instanceof Error)
            const processError = error as Error & {
                code: number
                stdout: string
                stderr: string
            }

            assert.equal(processError.code, 1)
            assert.equal(
                processError.stdout,
                [
                    'No final answer.',
                    '',
                    'Evidence:',
                    'Stop reason: transport_error',
                    'Tools: (none)',
                    'Files:',
                    '- (none)',
                    '',
                ].join('\n')
            )
            assert.equal(processError.stderr, '')

            return true
        }
    )
})

test('production entrypoint returns usage exit code 2 for invalid arguments', async () => {
    await assert.rejects(
        execFileAsync(process.execPath, ['src/cli.ts', 'ask', 'Inspect the workspace.']),
        (error: unknown) => {
            assert.ok(error instanceof Error)
            const processError = error as Error & {
                code: number
                stdout: string
                stderr: string
            }

            assert.equal(processError.code, 2)
            assert.equal(processError.stdout, '')
            assert.match(processError.stderr, /--cwd is required/)
            assert.match(processError.stderr, /Usage: yo ask/)

            return true
        }
    )
})
