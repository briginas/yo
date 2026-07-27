import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)

const runCliProcess = async (
    args: readonly string[],
    input: string,
    env: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['src/cli.ts', ...args], { env })
        let stdout = ''
        let stderr = ''

        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk
        })
        child.on('error', reject)
        child.on('close', (exitCode) => {
            resolve({ exitCode, stderr, stdout })
        })
        child.stdin.end(input)
    })

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

    const result = await runCliProcess([], 'Inspect the workspace.\n', {
        ...process.env,
        HOME: temporaryHome,
    })

    assert.equal(result.exitCode, 0)
    assert.equal(
        result.stdout,
        [
            'yo> Evidence:',
            'Stop reason: transport_error',
            'Tools: (none)',
            'Files:',
            '- (none)',
            'yo> ',
        ].join('\n')
    )
    assert.equal(
        result.stderr,
        [
            'status: model_waiting step=1',
            'status: turn_finished status=failed reason=transport_error',
            '',
        ].join('\n')
    )
})

test('production entrypoint rejects the removed ask command with usage exit code 2', async () => {
    await assert.rejects(
        execFileAsync(process.execPath, [
            'src/cli.ts',
            'ask',
            'Inspect the workspace.',
            '--cwd',
            '.',
        ]),
        (error: unknown) => {
            assert.ok(error instanceof Error)
            const processError = error as Error & {
                code: number
                stdout: string
                stderr: string
            }

            assert.equal(processError.code, 2)
            assert.equal(processError.stdout, '')
            assert.match(processError.stderr, /yo does not accept positional arguments/)
            assert.match(processError.stderr, /Usage: yo \[/)
            assert.doesNotMatch(processError.stderr, /yo ask/)
            assert.doesNotMatch(processError.stderr, /yo chat/)

            return true
        }
    )
})
