import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relative } from 'node:path'
import { test } from 'node:test'

import { runCli } from './cli-app.ts'
import type { ModelRequest, ModelTransport } from './runtime/run.ts'

type CliInvocation = {
    argv: readonly string[]
    transport?: ModelTransport | null
}

const invokeCli = async ({ argv, transport = null }: CliInvocation) => {
    const errors: string[] = []
    const result = await runCli(argv, {
        transport,
        writeError: (message) => errors.push(message),
    })

    return { errors, result }
}

test('runs ask with a canonical workspace, fixed budget, and no default model', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-workspace-`)
    const requests: ModelRequest[] = []
    const transport: ModelTransport = async (request) => {
        requests.push(request)

        return {
            type: 'final_answer',
            model: null,
            content: 'Found the runtime entrypoint.',
        }
    }

    try {
        const relativeWorkspace = relative(process.cwd(), workspace)
        const canonicalWorkspace = await realpath(workspace)
        const { errors, result } = await invokeCli({
            argv: ['ask', 'Find the runtime entrypoint.', '--cwd', relativeWorkspace],
            transport,
        })

        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.workspaceRoot, canonicalWorkspace)
        assert.equal(result.session?.task, 'Find the runtime entrypoint.')
        assert.deepEqual(result.session?.budget, {
            maxSteps: 10,
            perToolTimeoutMs: 5_000,
        })
        assert.equal(requests[0]?.model, null)
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('passes an explicit model and returns a failed session with exit code 1', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-model-`)
    const requests: ModelRequest[] = []
    const transport: ModelTransport = async (request) => {
        requests.push(request)
        throw new Error('transport unavailable')
    }

    try {
        const { errors, result } = await invokeCli({
            argv: ['ask', 'Inspect the workspace.', '--model', 'chosen-model', '--cwd', workspace],
            transport,
        })

        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 1)
        assert.equal(result.session?.status, 'failed')
        assert.equal(result.session?.stopReason, 'transport_error')
        assert.equal(requests[0]?.model, 'chosen-model')
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('rejects invalid command-line arguments with usage exit code 2', async (context) => {
    const cases = [
        { name: 'unknown command', argv: ['chat', 'task', '--cwd', '.'] },
        { name: 'missing task', argv: ['ask', '--cwd', '.'] },
        { name: 'empty task', argv: ['ask', '', '--cwd', '.'] },
        { name: 'whitespace task', argv: ['ask', '   ', '--cwd', '.'] },
        { name: 'missing cwd', argv: ['ask', 'task'] },
        { name: 'empty cwd', argv: ['ask', 'task', '--cwd', ''] },
        { name: 'whitespace cwd', argv: ['ask', 'task', '--cwd', '   '] },
        { name: 'missing cwd value', argv: ['ask', 'task', '--cwd'] },
        { name: 'empty model', argv: ['ask', 'task', '--cwd', '.', '--model', ''] },
        {
            name: 'whitespace model',
            argv: ['ask', 'task', '--cwd', '.', '--model', '   '],
        },
        { name: 'missing model value', argv: ['ask', 'task', '--cwd', '.', '--model'] },
        { name: 'option as cwd value', argv: ['ask', 'task', '--cwd', '-v'] },
        { name: 'unknown option', argv: ['ask', 'task', '--cwd', '.', '--verbose'] },
        { name: 'short option', argv: ['ask', 'task', '--cwd', '.', '-v'] },
        { name: 'extra task', argv: ['ask', 'task', 'extra', '--cwd', '.'] },
        { name: 'repeated cwd', argv: ['ask', 'task', '--cwd', '.', '--cwd', '.'] },
        {
            name: 'repeated model',
            argv: ['ask', 'task', '--cwd', '.', '--model', 'one', '--model', 'two'],
        },
    ] as const

    for (const testCase of cases) {
        await context.test(testCase.name, async () => {
            const { errors, result } = await invokeCli({ argv: testCase.argv })

            assert.equal(result.exitCode, 2)
            assert.equal(result.session, null)
            assert.equal(errors.length, 1)
            assert.match(errors[0]!, /Usage: yo ask/)
        })
    }
})

test('reports unavailable production transport after argument validation', async () => {
    const { errors, result } = await invokeCli({
        argv: ['ask', 'Inspect the workspace.', '--cwd', '.'],
    })

    assert.deepEqual(result, {
        exitCode: 1,
        session: null,
    })
    assert.deepEqual(errors, ['OpenAI transport is not available yet; complete milestone 6 first.'])
})

test('reports workspace canonicalization failures as runtime errors', async () => {
    const transport: ModelTransport = async () => ({
        type: 'final_answer',
        model: null,
        content: 'unused',
    })
    const { errors, result } = await invokeCli({
        argv: ['ask', 'Inspect the workspace.', '--cwd', '/missing/yo-workspace'],
        transport,
    })

    assert.deepEqual(result, {
        exitCode: 1,
        session: null,
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /^Cannot use workspace:/)
})
