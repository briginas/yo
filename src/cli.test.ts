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
    assert.match(result.stdout, /Run #1 result: failed/)
    assert.match(result.stdout, /Stop reason: transport_error/)
    assert.match(result.stdout, /Tools: \(none\)/)
    assert.match(result.stdout, /Errors:\n- transport_error/)
    assert.match(result.stdout, /Session runs:\n- #1 Inspect the workspace\. \| failed/)
    assert.equal((result.stdout.match(/Evidence:/g) ?? []).length, 1)
    assert.match(result.stderr, /Run #1: Inspect the workspace\. \| start=/)
    assert.match(result.stderr, /event: run=1 #1 run_started/)
    assert.match(result.stderr, /event: run=1 #2 model_requested step=1/)
    assert.match(result.stderr, /event: run=1 #3 run_finished outcome=transport_error/)
    assert.doesNotMatch(result.stderr, /status: model_waiting|status: turn_finished/)
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
