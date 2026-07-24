import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relative } from 'node:path'
import { test } from 'node:test'

import { runCli } from './cli-app.ts'
import type {
    OpenAICodexAuthorization,
    OpenAICodexCallbackListener,
    OpenAICodexCallbackListenerOptions,
} from './auth/openai-codex-login.ts'
import type { ModelRequest, ModelTransport } from './runtime/run.ts'

type CliInvocation = {
    argv: readonly string[]
    transport?: ModelTransport | null
    createAuthorization?: () => OpenAICodexAuthorization
    startCallbackListener?: (
        options: OpenAICodexCallbackListenerOptions
    ) => Promise<OpenAICodexCallbackListener>
}

const invokeCli = async ({
    argv,
    transport = null,
    createAuthorization,
    startCallbackListener,
}: CliInvocation) => {
    const outputs: string[] = []
    const errors: string[] = []
    const result = await runCli(argv, {
        transport,
        writeOutput: (message) => outputs.push(message),
        writeError: (message) => errors.push(message),
        ...(createAuthorization === undefined ? {} : { createAuthorization }),
        ...(startCallbackListener === undefined ? {} : { startCallbackListener }),
    })

    return { errors, outputs, result }
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
        const { errors, outputs, result } = await invokeCli({
            argv: ['ask', 'Find the runtime entrypoint.', '--cwd', relativeWorkspace],
            transport,
        })

        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, [
            [
                'Found the runtime entrypoint.',
                '',
                'Evidence:',
                'Stop reason: final_answer',
                'Tools: (none)',
                'Files:',
                '- (none)',
            ].join('\n'),
        ])
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
        const { errors, outputs, result } = await invokeCli({
            argv: ['ask', 'Inspect the workspace.', '--model', 'chosen-model', '--cwd', workspace],
            transport,
        })

        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, [
            [
                'No final answer.',
                '',
                'Evidence:',
                'Stop reason: transport_error',
                'Tools: (none)',
                'Files:',
                '- (none)',
            ].join('\n'),
        ])
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
            const { errors, outputs, result } = await invokeCli({ argv: testCase.argv })

            assert.equal(result.exitCode, 2)
            assert.equal(result.session, null)
            assert.deepEqual(outputs, [])
            assert.equal(errors.length, 1)
            assert.match(errors[0]!, /Usage: yo ask/)
        })
    }
})

test('reports unavailable production transport after argument validation', async () => {
    const { errors, outputs, result } = await invokeCli({
        argv: ['ask', 'Inspect the workspace.', '--cwd', '.'],
    })

    assert.deepEqual(outputs, [])
    assert.deepEqual(result, {
        exitCode: 1,
        session: null,
    })
    assert.deepEqual(errors, ['OpenAI transport is not available yet; complete milestone 6 first.'])
})

test('prints an authorization URL only after the callback listener is ready', async () => {
    const events: string[] = []
    let callbackOptions: OpenAICodexCallbackListenerOptions | undefined
    const authorization = {
        authorizationUrl:
            'https://auth.openai.com/oauth/authorize?state=public-state&code_challenge=challenge',
        codeVerifier: 'private-verifier',
        state: 'public-state',
    }
    const outputs: string[] = []
    const errors: string[] = []

    const result = await runCli(['login'], {
        transport: null,
        createAuthorization: () => authorization,
        startCallbackListener: async (options) => {
            events.push('listener_started')
            callbackOptions = options
            return {
                waitForCallback: async () => ({
                    status: 'accepted',
                    code: 'authorization-code',
                }),
                close: async () => {
                    events.push('listener_closed')
                },
            }
        },
        writeOutput: (message) => {
            events.push('output')
            outputs.push(message)
        },
        writeError: (message) => errors.push(message),
    })

    assert.deepEqual(callbackOptions, { expectedState: authorization.state })
    assert.deepEqual(events, ['listener_started', 'output', 'output', 'listener_closed'])
    assert.deepEqual(errors, [])
    assert.deepEqual(outputs, [
        `Open this URL in your browser:\n${authorization.authorizationUrl}`,
        'Authorization received. Credential exchange will be implemented in milestone 6.2.3.',
    ])
    assert.equal(result.exitCode, 0)
    assert.equal(result.session, null)
    assert.doesNotMatch(
        `${outputs.join('\n')}\n${errors.join('\n')}`,
        /private-verifier|authorization-code/
    )
})

test('reports an occupied OAuth callback port without printing an authorization URL', async () => {
    const { errors, outputs, result } = await invokeCli({
        argv: ['login'],
        createAuthorization: () => ({
            authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=public-state',
            codeVerifier: 'private-verifier',
            state: 'public-state',
        }),
        startCallbackListener: async () => {
            throw Object.assign(new Error('callback port is reserved'), { code: 'EADDRINUSE' })
        },
    })

    assert.deepEqual(outputs, [])
    assert.deepEqual(result, { exitCode: 1, session: null })
    assert.deepEqual(errors, [
        'OAuth callback address 127.0.0.1:1455 is already in use. Close the other listener and try again.',
    ])
})

test('reports a rejected OAuth callback and closes its listener', async () => {
    let closeCount = 0
    const { errors, outputs, result } = await invokeCli({
        argv: ['login'],
        createAuthorization: () => ({
            authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=public-state',
            codeVerifier: 'private-verifier',
            state: 'public-state',
        }),
        startCallbackListener: async () => ({
            waitForCallback: async () => ({ status: 'rejected', reason: 'state_mismatch' }),
            close: async () => {
                closeCount += 1
            },
        }),
    })

    assert.deepEqual(outputs, [
        'Open this URL in your browser:\nhttps://auth.openai.com/oauth/authorize?state=public-state',
    ])
    assert.deepEqual(errors, ['OAuth callback state did not match the login request.'])
    assert.deepEqual(result, { exitCode: 1, session: null })
    assert.equal(closeCount, 1)
})

test('reports workspace canonicalization failures as runtime errors', async () => {
    const transport: ModelTransport = async () => ({
        type: 'final_answer',
        model: null,
        content: 'unused',
    })
    const { errors, outputs, result } = await invokeCli({
        argv: ['ask', 'Inspect the workspace.', '--cwd', '/missing/yo-workspace'],
        transport,
    })

    assert.deepEqual(outputs, [])
    assert.deepEqual(result, {
        exitCode: 1,
        session: null,
    })
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /^Cannot use workspace:/)
})

test('prints ordered, deduplicated tool and file evidence from successful observations', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-evidence-`)
    let requestCount = 0
    const transport: ModelTransport = async () => {
        requestCount += 1

        if (requestCount === 1) {
            return {
                type: 'tool_calls',
                model: null,
                toolCalls: [
                    {
                        id: 'list-call',
                        name: 'list_files',
                        arguments: { path: 'src' },
                    },
                    {
                        id: 'search-call',
                        name: 'search_code',
                        arguments: { query: 'needle', path: '.' },
                    },
                    {
                        id: 'read-call',
                        name: 'read_file',
                        arguments: { path: './src/agent.ts' },
                    },
                    {
                        id: 'repeated-search-call',
                        name: 'search_code',
                        arguments: { query: 'needle', path: 'src' },
                    },
                ],
            }
        }

        return {
            type: 'final_answer',
            model: null,
            content: 'The answer is in src/agent.ts.',
        }
    }

    try {
        await mkdir(`${workspace}/src`)
        await writeFile(`${workspace}/src/agent.ts`, 'export const needle = 42\n')

        const { errors, outputs, result } = await invokeCli({
            argv: ['ask', 'Find the answer.', '--cwd', workspace],
            transport,
        })

        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 0)
        assert.deepEqual(outputs, [
            [
                'The answer is in src/agent.ts.',
                '',
                'Evidence:',
                'Stop reason: final_answer',
                'Tools: list_files, search_code, read_file',
                'Files:',
                '- src/agent.ts',
            ].join('\n'),
        ])
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('completes a fixture-repository research task with a faux transport', async () => {
    const fixtureRoot = await mkdtemp(`${tmpdir()}/yo-cli-fixture-`)
    const workspace = `${fixtureRoot}/workspace`
    const sourceDirectory = `${workspace}/src`
    const sourcePath = `${sourceDirectory}/settings.ts`
    const source = 'export const defaultTimeoutMs = 5_000\n'
    const requests: ModelRequest[] = []
    const searchCall = {
        id: 'search-call',
        name: 'search_code' as const,
        arguments: { query: 'defaultTimeoutMs', path: 'src' },
    }
    const readCall = {
        id: 'read-call',
        name: 'read_file' as const,
        arguments: { path: 'src/settings.ts' },
    }
    const transport: ModelTransport = async (request) => {
        requests.push(request)

        if (requests.length === 1) {
            return {
                type: 'tool_calls',
                model: 'faux-model',
                content: 'I will locate the timeout setting.',
                toolCalls: [searchCall],
            }
        }

        if (requests.length === 2) {
            return {
                type: 'tool_calls',
                model: 'faux-model',
                content: 'I found the setting and will read its definition.',
                toolCalls: [readCall],
            }
        }

        return {
            type: 'final_answer',
            model: 'faux-model',
            content: 'The default timeout is 5,000 ms in src/settings.ts:1.',
        }
    }

    try {
        await mkdir(sourceDirectory, { recursive: true })
        await writeFile(sourcePath, source)

        const { errors, outputs, result } = await invokeCli({
            argv: ['ask', 'Find the default timeout and cite its definition.', '--cwd', workspace],
            transport,
        })

        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, [
            [
                'The default timeout is 5,000 ms in src/settings.ts:1.',
                '',
                'Evidence:',
                'Stop reason: final_answer',
                'Tools: search_code, read_file',
                'Files:',
                '- src/settings.ts',
            ].join('\n'),
        ])
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'completed')
        assert.equal(result.session?.stopReason, 'final_answer')
        assert.equal(result.session?.stepCount, 3)
        assert.equal(requests.length, 3)
        assert.deepEqual(requests[1]?.messages.at(-1), {
            role: 'tool',
            result: {
                status: 'success',
                callId: searchCall.id,
                content: 'src/settings.ts:1:export const defaultTimeoutMs = 5_000',
                metadata: {
                    truncated: false,
                    truncation: null,
                },
            },
        })
        assert.deepEqual(requests[2]?.messages.at(-1), {
            role: 'tool',
            result: {
                status: 'success',
                callId: readCall.id,
                content: '1:export const defaultTimeoutMs = 5_000',
                metadata: {
                    truncated: false,
                    truncation: null,
                },
            },
        })
        assert.equal(await readFile(sourcePath, 'utf8'), source)
        assert.deepEqual(await readdir(workspace), ['src'])
        assert.deepEqual(await readdir(sourceDirectory), ['settings.ts'])
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('prints a failed report after step-budget exhaustion without authorized evidence', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-budget-`)
    const transport: ModelTransport = async () => ({
        type: 'tool_calls',
        model: null,
        toolCalls: [
            {
                id: 'unknown-call',
                name: 'unknown_tool',
                arguments: {},
            },
        ],
    })

    try {
        const { errors, outputs, result } = await invokeCli({
            argv: ['ask', 'Inspect the workspace.', '--cwd', workspace],
            transport,
        })

        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 1)
        assert.equal(result.session?.stopReason, 'step_budget_exhausted')
        assert.deepEqual(outputs, [
            [
                'No final answer.',
                '',
                'Evidence:',
                'Stop reason: step_budget_exhausted',
                'Tools: (none)',
                'Files:',
                '- (none)',
            ].join('\n'),
        ])
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})
