import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { runCli } from './cli-app.ts'
import { createFileCredentialStore } from './auth/file-credential-store.ts'
import type {
    CallbackServerListenOptions,
    OpenAICodexAuthorization,
    OpenAICodexCallbackListener,
    OpenAICodexCallbackListenerOptions,
} from './auth/openai-codex-login.ts'
import {
    exchangeOpenAICodexAuthorizationCode,
    OPENAI_CODEX_AUTH_CLAIM,
    startOpenAICodexCallbackListener,
} from './auth/openai-codex-login.ts'
import {
    OPENAI_CODEX_PROVIDER_ID,
    type Credential,
    type CredentialStore,
} from './auth/credential.ts'
import { CHAT_PROMPT, type LineInput } from './line-input.ts'
import { createOpenAICodexResponsesTransport } from './provider/openai-codex-responses.ts'
import type { ModelRequest, ModelTransport } from './runtime/run.ts'
import { PATCH_APPROVAL_PROMPT } from './terminal-approval.ts'

type CliInvocation = {
    argv: readonly string[]
    transport?: ModelTransport
    createAuthorization?: () => OpenAICodexAuthorization
    startCallbackListener?: (
        options: OpenAICodexCallbackListenerOptions
    ) => Promise<OpenAICodexCallbackListener>
    credentialStore?: CredentialStore
    exchangeCredential?: (options: { code: string; codeVerifier: string }) => Promise<Credential>
    createLineInput?: () => LineInput
    clearStatusLine?: () => void
    moveStatusCursorToStart?: () => void
    isInteractive?: boolean
}

const invokeCli = async ({
    argv,
    transport,
    createAuthorization,
    startCallbackListener,
    credentialStore,
    exchangeCredential,
    createLineInput,
    clearStatusLine,
    moveStatusCursorToStart,
    isInteractive,
}: CliInvocation) => {
    const outputs: string[] = []
    const answers: string[] = []
    const statuses: string[] = []
    const errors: string[] = []
    const result = await runCli(argv, {
        transport:
            transport ??
            (async () => {
                throw new Error('transport not provided')
            }),
        writeOutput: (message) => outputs.push(message),
        writeError: (message) => errors.push(message),
        createLineInput:
            createLineInput ??
            (() => ({
                readLine: async () => null,
                close: () => undefined,
            })),
        writeAnswer: (message) => answers.push(message),
        writeStatus: (message) => statuses.push(message),
        clearStatusLine: clearStatusLine ?? (() => undefined),
        moveStatusCursorToStart: moveStatusCursorToStart ?? (() => undefined),
        isInteractive: isInteractive ?? false,
        ...(createAuthorization === undefined ? {} : { createAuthorization }),
        ...(startCallbackListener === undefined ? {} : { startCallbackListener }),
        ...(credentialStore === undefined ? {} : { credentialStore }),
        ...(exchangeCredential === undefined ? {} : { exchangeCredential }),
    })

    return { answers, errors, outputs, result, statuses }
}

const serializeSseEvent = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`

const createChunkedSseResponse = (payload: string, chunkSize: number): Response => {
    const bytes = new TextEncoder().encode(payload)

    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                    controller.enqueue(bytes.slice(offset, offset + chunkSize))
                }

                controller.close()
            },
        }),
        {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        }
    )
}

test('runs a chat turn with a canonical workspace, fixed budget, and no default model', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-workspace-`)
    const requests: ModelRequest[] = []
    const lines = ['Find the runtime entrypoint.', '/exit']
    const transport: ModelTransport = async (request, options) => {
        requests.push(request)
        options?.onFinalAnswerDelta?.('Found the runtime ')
        options?.onFinalAnswerDelta?.('entrypoint.')

        return {
            type: 'final_answer',
            model: null,
            content: 'Found the runtime entrypoint.',
        }
    }

    try {
        const relativeWorkspace = relative(process.cwd(), workspace)
        const canonicalWorkspace = await realpath(workspace)
        const { answers, errors, outputs, result, statuses } = await invokeCli({
            argv: ['--cwd', relativeWorkspace],
            transport,
            createLineInput: () => ({
                readLine: async () => lines.shift() ?? null,
                close: () => undefined,
            }),
        })

        assert.deepEqual(answers, ['Found the runtime ', 'entrypoint.', '\n\n'])
        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, [
            ['Evidence:', 'Stop reason: final_answer', 'Tools: (none)', 'Files:', '- (none)'].join(
                '\n'
            ),
        ])
        assert.deepEqual(statuses, [
            'status: model_waiting step=1\n',
            'status: model_ready step=1\n',
            'status: turn_finished status=completed reason=final_answer\n',
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

test('uses the current directory when cwd is omitted', async () => {
    const lines = ['Inspect the current workspace.', '/exit']
    const canonicalWorkspace = await realpath(process.cwd())
    const { errors, result } = await invokeCli({
        argv: [],
        transport: async () => ({
            type: 'final_answer',
            model: null,
            content: 'Inspection complete.',
        }),
        createLineInput: () => ({
            readLine: async () => lines.shift() ?? null,
            close: () => undefined,
        }),
    })

    assert.deepEqual(errors, [])
    assert.equal(result.exitCode, 0)
    assert.equal(result.session?.workspaceRoot, canonicalWorkspace)
})

test('falls back to the completed answer for a chat turn without deltas', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-answer-fallback-`)
    const lines = ['Inspect the workspace.', '/exit']

    try {
        const { answers, errors, outputs, result } = await invokeCli({
            argv: ['--cwd', workspace],
            transport: async () => ({
                type: 'final_answer',
                model: null,
                content: 'Inspection complete.',
            }),
            createLineInput: () => ({
                readLine: async () => lines.shift() ?? null,
                close: () => undefined,
            }),
        })

        assert.deepEqual(answers, ['Inspection complete.\n\n'])
        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, [
            ['Evidence:', 'Stop reason: final_answer', 'Tools: (none)', 'Files:', '- (none)'].join(
                '\n'
            ),
        ])
        assert.equal(result.exitCode, 0)
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('passes an explicit model and retains a failed chat turn', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-model-`)
    const requests: ModelRequest[] = []
    const lines = ['Inspect the workspace.', '/exit']
    const transport: ModelTransport = async (request) => {
        requests.push(request)
        throw new Error('transport unavailable')
    }

    try {
        const { answers, errors, outputs, result, statuses } = await invokeCli({
            argv: ['--model', 'chosen-model', '--cwd', workspace],
            transport,
            createLineInput: () => ({
                readLine: async () => lines.shift() ?? null,
                close: () => undefined,
            }),
        })

        assert.deepEqual(answers, [])
        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, [
            [
                'Evidence:',
                'Stop reason: transport_error',
                'Tools: (none)',
                'Files:',
                '- (none)',
            ].join('\n'),
        ])
        assert.deepEqual(statuses, [
            'status: model_waiting step=1\n',
            'status: turn_finished status=failed reason=transport_error\n',
        ])
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'failed')
        assert.equal(result.session?.stopReason, 'transport_error')
        assert.equal(requests[0]?.model, 'chosen-model')
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('composes a tool-using chat turn and retains its observations for a follow-up', async () => {
    const fixtureRoot = await mkdtemp(`${tmpdir()}/yo-cli-chat-`)
    const workspace = join(fixtureRoot, 'workspace')
    const sourceDirectory = join(workspace, 'src')
    const sourcePath = join(sourceDirectory, 'settings.ts')
    const source = 'export const defaultTimeoutMs = 5_000\n'
    const requests: ModelRequest[] = []
    const lines = [
        'Find the default timeout.',
        'What did the earlier observation establish?',
        '/exit',
    ]
    let lineIndex = 0
    let closeCount = 0
    const privateTranscriptMarker = 'Bearer private-access-token'
    const transport: ModelTransport = async (request, options) => {
        requests.push(request)

        if (requests.length === 1) {
            return {
                type: 'tool_calls',
                model: 'chosen-model',
                content: privateTranscriptMarker,
                toolCalls: [
                    {
                        id: 'search-call',
                        name: 'search_code',
                        arguments: { query: 'defaultTimeoutMs', path: 'src' },
                    },
                ],
            }
        }

        const content =
            requests.length === 2
                ? 'The default timeout is 5,000 ms.'
                : 'The earlier observation found the definition in src/settings.ts:1.'

        options?.onFinalAnswerDelta?.(content)

        return {
            type: 'final_answer',
            model: 'chosen-model',
            content,
        }
    }

    try {
        await mkdir(sourceDirectory, { recursive: true })
        await writeFile(sourcePath, source)
        const relativeWorkspace = relative(process.cwd(), workspace)
        const canonicalWorkspace = await realpath(workspace)
        const { answers, errors, outputs, result, statuses } = await invokeCli({
            argv: ['--model', 'chosen-model', '--cwd', relativeWorkspace],
            transport,
            createLineInput: () => ({
                readLine: async () => lines[lineIndex++] ?? null,
                close: () => {
                    closeCount += 1
                },
            }),
        })

        assert.deepEqual(errors, [])
        assert.deepEqual(answers, [
            'The default timeout is 5,000 ms.',
            '\n\n',
            'The earlier observation found the definition in src/settings.ts:1.',
            '\n\n',
        ])
        assert.deepEqual(outputs, [
            [
                'Evidence:',
                'Stop reason: final_answer',
                'Tools: search_code',
                'Files:',
                '- src/settings.ts',
            ].join('\n'),
            ['Evidence:', 'Stop reason: final_answer', 'Tools: (none)', 'Files:', '- (none)'].join(
                '\n'
            ),
        ])
        assert.deepEqual(statuses, [
            'status: model_waiting step=1\n',
            'status: model_ready step=1\n',
            'status: tool_running step=1 tool=search_code query="defaultTimeoutMs" path="src"\n',
            'status: tool_completed step=1 tool=search_code query="defaultTimeoutMs" path="src"\n',
            'status: model_waiting step=2\n',
            'status: model_ready step=2\n',
            'status: turn_finished status=completed reason=final_answer\n',
            'status: model_waiting step=1\n',
            'status: model_ready step=1\n',
            'status: turn_finished status=completed reason=final_answer\n',
        ])
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.task, 'What did the earlier observation establish?')
        assert.equal(result.session?.workspaceRoot, canonicalWorkspace)
        assert.equal(result.session?.budget.maxSteps, 10)
        assert.equal(result.session?.stepCount, 1)
        assert.equal(requests.length, 3)
        assert.equal(requests[0]?.model, 'chosen-model')
        assert.equal(requests[1]?.model, 'chosen-model')
        assert.equal(requests[2]?.model, 'chosen-model')
        assert.deepEqual(
            requests[2]?.messages.map((message) => message.role),
            ['system', 'user', 'assistant', 'tool', 'assistant', 'user']
        )
        const firstUserMessage = requests[2]?.messages[1]
        const toolCallMessage = requests[2]?.messages[2]
        const toolResultMessage = requests[2]?.messages[3]
        const firstAnswerMessage = requests[2]?.messages[4]
        const secondUserMessage = requests[2]?.messages[5]

        assert.ok(firstUserMessage?.role === 'user')
        assert.ok(toolCallMessage?.role === 'assistant')
        assert.ok(toolResultMessage?.role === 'tool')
        assert.ok(firstAnswerMessage?.role === 'assistant')
        assert.ok(secondUserMessage?.role === 'user')
        assert.equal(firstUserMessage.content, 'Find the default timeout.')
        assert.equal(toolCallMessage.content, privateTranscriptMarker)
        assert.deepEqual(toolCallMessage.toolCalls, [
            {
                id: 'search-call',
                name: 'search_code',
                arguments: { query: 'defaultTimeoutMs', path: 'src' },
            },
        ])
        assert.equal(toolResultMessage.result.status, 'success')
        assert.equal(
            toolResultMessage.result.content,
            'src/settings.ts:1:export const defaultTimeoutMs = 5_000'
        )
        assert.equal(firstAnswerMessage.content, 'The default timeout is 5,000 ms.')
        assert.equal(secondUserMessage.content, 'What did the earlier observation establish?')
        assert.equal(
            [...answers, ...outputs, ...statuses, ...errors]
                .join('')
                .includes(privateTranscriptMarker),
            false
        )
        assert.equal(closeCount, 1)
        assert.equal(await readFile(sourcePath, 'utf8'), source)
        assert.deepEqual(await readdir(workspace), ['src'])
        assert.deepEqual(await readdir(sourceDirectory), ['settings.ts'])
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('composes confirmed Codex answer chunks after tool work without crossing terminal channels', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-output-composition-`)
    const sourcePath = join(workspace, 'answer.ts')
    const lines = ['Read the answer.', '/exit']
    const privatePreamble = 'private assistant preamble'
    const privateReasoning = 'private reasoning summary'
    const credential = {
        type: 'oauth',
        accessToken: 'private-access-token',
        refreshToken: 'private-refresh-token',
        expiresAt: 4_000_000_000_000,
        accountId: 'account-id',
    } as const satisfies Credential
    const providerPayloads = [
        serializeSseEvent({
            type: 'response.completed',
            response: {
                model: 'test-model',
                output: [
                    {
                        type: 'message',
                        content: [{ type: 'output_text', text: privatePreamble }],
                    },
                    {
                        type: 'function_call',
                        call_id: 'call-read',
                        name: 'read_file',
                        arguments: '{"path":"answer.ts"}',
                    },
                ],
            },
        }),
        [
            serializeSseEvent({
                type: 'response.reasoning_summary_text.delta',
                delta: privateReasoning,
            }),
            serializeSseEvent({
                type: 'response.output_text.delta',
                output_index: 1,
                delta: 'Confirmed ',
            }),
            serializeSseEvent({
                type: 'response.output_text.delta',
                output_index: 1,
                delta: 'answer.',
            }),
            serializeSseEvent({
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    type: 'reasoning',
                    summary: [{ text: privateReasoning }],
                },
            }),
            serializeSseEvent({
                type: 'response.output_item.done',
                output_index: 1,
                item: {
                    type: 'message',
                    content: [{ type: 'output_text', text: 'Confirmed answer.' }],
                },
            }),
            serializeSseEvent({
                type: 'response.completed',
                response: {
                    model: 'test-model',
                    output: [
                        {
                            type: 'reasoning',
                            summary: [{ text: privateReasoning }],
                        },
                        {
                            type: 'message',
                            content: [{ type: 'output_text', text: 'Confirmed answer.' }],
                        },
                    ],
                },
            }),
        ].join(''),
    ]
    let providerRequestIndex = 0
    const transport = createOpenAICodexResponsesTransport({
        credentialStore: {
            read: async () => credential,
            modify: async () => credential,
            delete: async () => undefined,
        },
        resolveCredential: async () => credential,
        fetch: async () => createChunkedSseResponse(providerPayloads[providerRequestIndex++]!, 3),
    })
    const answers: string[] = []
    const outputs: string[] = []
    const statuses: string[] = []
    const errors: string[] = []
    const terminalOperations: string[] = []

    try {
        await writeFile(sourcePath, 'export const answer = 42\n')

        const result = await runCli(['--cwd', workspace], {
            transport,
            writeOutput: (message) => outputs.push(message),
            writeError: (message) => errors.push(message),
            createLineInput: () => ({
                readLine: async () => lines.shift() ?? null,
                close: () => undefined,
            }),
            writeAnswer: (message) => {
                answers.push(message)
                terminalOperations.push(`answer:${message}`)
            },
            writeStatus: (message) => {
                statuses.push(message)
                terminalOperations.push(`status:${message}`)
            },
            clearStatusLine: () => terminalOperations.push('clear'),
            moveStatusCursorToStart: () => terminalOperations.push('cursor-start'),
            isInteractive: true,
        })

        assert.deepEqual(answers, ['Confirmed ', 'answer.', '\n\n'])
        assert.deepEqual(outputs, [
            [
                'Evidence:',
                'Stop reason: final_answer',
                'Tools: read_file',
                'Files:',
                '- answer.ts',
            ].join('\n'),
        ])
        assert.deepEqual(statuses, [
            'status: model_waiting step=1',
            'status: tool_running step=1 tool=read_file path="answer.ts"',
            'status: tool_completed step=1 tool=read_file path="answer.ts"\n',
            'status: model_waiting step=2',
            'status: turn_finished status=completed reason=final_answer\n',
        ])
        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 0)
        assert.equal(providerRequestIndex, 2)

        const firstAnswerIndex = terminalOperations.indexOf('answer:Confirmed ')

        assert.notEqual(firstAnswerIndex, -1)
        assert.deepEqual(terminalOperations.slice(firstAnswerIndex - 2, firstAnswerIndex), [
            'clear',
            'cursor-start',
        ])
        assert.deepEqual(terminalOperations.slice(-2), [
            'answer:\n\n',
            'status:status: turn_finished status=completed reason=final_answer\n',
        ])

        const visibleOutput = [...answers, ...outputs, ...statuses, ...errors].join('')

        assert.equal(visibleOutput.includes(privatePreamble), false)
        assert.equal(visibleOutput.includes(privateReasoning), false)
        assert.equal(visibleOutput.includes(credential.accessToken), false)
        assert.equal(visibleOutput.includes(credential.refreshToken), false)
        assert.equal(visibleOutput.match(/Confirmed answer\./gu)?.length, 1)
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('handles EOF, exact exit, and blank chat input without invoking the model', async (context) => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-chat-input-`)
    const cases = [
        { name: 'EOF', lines: [null], promptCount: 1 },
        { name: 'exact exit', lines: ['/exit'], promptCount: 1 },
        { name: 'blank input', lines: ['', '   ', '\t', '/exit'], promptCount: 4 },
    ] as const

    try {
        for (const testCase of cases) {
            await context.test(testCase.name, async () => {
                const prompts: string[] = []
                let lineIndex = 0
                let closeCount = 0
                let transportCallCount = 0
                const { answers, errors, outputs, result, statuses } = await invokeCli({
                    argv: ['--cwd', workspace],
                    transport: async () => {
                        transportCallCount += 1
                        throw new Error('transport must not be called')
                    },
                    createLineInput: () => ({
                        readLine: async (prompt) => {
                            prompts.push(prompt)
                            return testCase.lines[lineIndex++] ?? null
                        },
                        close: () => {
                            closeCount += 1
                        },
                    }),
                })

                assert.deepEqual(result, { exitCode: 0, session: null })
                assert.deepEqual(answers, [])
                assert.deepEqual(errors, [])
                assert.deepEqual(outputs, [])
                assert.deepEqual(statuses, [])
                assert.deepEqual(prompts, Array(testCase.promptCount).fill(CHAT_PROMPT))
                assert.equal(transportCallCount, 0)
                assert.equal(closeCount, 1)
            })
        }
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('reports a sanitized transport failure and continues with the next chat turn', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-chat-transport-`)
    const requests: ModelRequest[] = []
    const lines = ['private transcript marker', 'Recover on the next turn.', '/exit']
    let lineIndex = 0
    let closeCount = 0
    let clearCount = 0
    let moveCount = 0
    const privateTransportError = 'Bearer private-access-token raw transport failure'
    const transport: ModelTransport = async (request) => {
        requests.push(request)

        if (requests.length === 1) {
            throw new Error(privateTransportError)
        }

        return {
            type: 'final_answer',
            model: null,
            content: 'The second turn completed.',
        }
    }

    try {
        const { answers, errors, outputs, result, statuses } = await invokeCli({
            argv: ['--cwd', workspace],
            transport,
            createLineInput: () => ({
                readLine: async () => lines[lineIndex++] ?? null,
                close: () => {
                    closeCount += 1
                },
            }),
            clearStatusLine: () => {
                clearCount += 1
            },
            moveStatusCursorToStart: () => {
                moveCount += 1
            },
            isInteractive: true,
        })

        assert.deepEqual(errors, [])
        assert.deepEqual(answers, ['The second turn completed.\n\n'])
        assert.deepEqual(outputs, [
            [
                'Evidence:',
                'Stop reason: transport_error',
                'Tools: (none)',
                'Files:',
                '- (none)',
            ].join('\n'),
            ['Evidence:', 'Stop reason: final_answer', 'Tools: (none)', 'Files:', '- (none)'].join(
                '\n'
            ),
        ])
        assert.deepEqual(statuses, [
            'status: model_waiting step=1',
            'status: turn_finished status=failed reason=transport_error\n',
            'status: model_waiting step=1',
            'status: turn_finished status=completed reason=final_answer\n',
        ])
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'completed')
        assert.equal(result.session?.stepCount, 1)
        assert.equal(requests.length, 2)
        assert.deepEqual(
            requests[1]?.messages.map((message) => message.role),
            ['system', 'user', 'user']
        )
        assert.deepEqual(requests[1]?.messages.slice(1), [
            { role: 'user', content: 'private transcript marker' },
            { role: 'user', content: 'Recover on the next turn.' },
        ])
        assert.equal(
            [...answers, ...outputs, ...statuses, ...errors]
                .join('')
                .includes(privateTransportError),
            false
        )
        assert.equal(
            [...answers, ...outputs, ...statuses, ...errors]
                .join('')
                .includes('private transcript marker'),
            false
        )
        assert.equal(clearCount, 4)
        assert.equal(moveCount, 4)
        assert.equal(closeCount, 1)
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('reports step-budget exhaustion and resets the budget for the next chat turn', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-chat-budget-`)
    const requests: ModelRequest[] = []
    const lines = ['Exhaust this turn.', 'Recover with a fresh budget.', '/exit']
    let lineIndex = 0
    const privateArgument = 'Bearer private-access-token'
    const transport: ModelTransport = async (request) => {
        requests.push(request)

        if (requests.length <= 10) {
            return {
                type: 'tool_calls',
                model: null,
                toolCalls: [
                    {
                        id: `unknown-call-${requests.length}`,
                        name: 'unknown_tool',
                        arguments: { authorization: privateArgument },
                    },
                ],
            }
        }

        return {
            type: 'final_answer',
            model: null,
            content: 'The fresh turn completed.',
        }
    }

    try {
        const { answers, errors, outputs, result, statuses } = await invokeCli({
            argv: ['--cwd', workspace],
            transport,
            createLineInput: () => ({
                readLine: async () => lines[lineIndex++] ?? null,
                close: () => undefined,
            }),
        })

        assert.deepEqual(errors, [])
        assert.deepEqual(answers, ['The fresh turn completed.\n\n'])
        assert.deepEqual(outputs, [
            [
                'Evidence:',
                'Stop reason: step_budget_exhausted',
                'Tools: (none)',
                'Files:',
                '- (none)',
            ].join('\n'),
            ['Evidence:', 'Stop reason: final_answer', 'Tools: (none)', 'Files:', '- (none)'].join(
                '\n'
            ),
        ])
        assert.deepEqual(statuses.slice(0, 3), [
            'status: model_waiting step=1\n',
            'status: model_ready step=1\n',
            'status: tool_failed step=1 tool=unknown_tool arguments=unavailable\n',
        ])
        assert.deepEqual(statuses.slice(27, 31), [
            'status: model_waiting step=10\n',
            'status: model_ready step=10\n',
            'status: tool_failed step=10 tool=unknown_tool arguments=unavailable\n',
            'status: turn_finished status=aborted reason=step_budget_exhausted\n',
        ])
        assert.deepEqual(statuses.slice(31), [
            'status: model_waiting step=1\n',
            'status: model_ready step=1\n',
            'status: turn_finished status=completed reason=final_answer\n',
        ])
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'completed')
        assert.equal(result.session?.stepCount, 1)
        assert.equal(requests.length, 11)
        assert.deepEqual(requests[10]?.messages.at(-1), {
            role: 'user',
            content: 'Recover with a fresh budget.',
        })
        assert.equal(
            [...answers, ...outputs, ...statuses, ...errors].join('').includes(privateArgument),
            false
        )
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('rejects chat before the input boundary when its workspace cannot be canonicalized', async () => {
    const { errors, outputs, result } = await invokeCli({
        argv: ['--cwd', '/missing/yo-chat-workspace'],
    })

    assert.deepEqual(result, { exitCode: 1, session: null })
    assert.deepEqual(outputs, [])
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /^Cannot use workspace:/)
})

test('rejects invalid command-line arguments with usage exit code 2', async (context) => {
    const cases = [
        { name: 'removed chat command', argv: ['chat', '--cwd', '.'] },
        { name: 'missing cwd value', argv: ['--cwd'] },
        { name: 'empty cwd', argv: ['--cwd', ''] },
        { name: 'missing model value', argv: ['--cwd', '.', '--model'] },
        { name: 'unknown option', argv: ['--cwd', '.', '--verbose'] },
        { name: 'removed ask command', argv: ['ask', 'task', '--cwd', '.'] },
        { name: 'login arguments', argv: ['login', 'extra'] },
        { name: 'missing auth subcommand', argv: ['auth'] },
        { name: 'unknown auth subcommand', argv: ['auth', 'logout'] },
        { name: 'auth status arguments', argv: ['auth', 'status', 'extra'] },
        { name: 'logout arguments', argv: ['logout', 'extra'] },
    ] as const

    for (const testCase of cases) {
        await context.test(testCase.name, async () => {
            const { errors, outputs, result } = await invokeCli({ argv: testCase.argv })

            assert.equal(result.exitCode, 2)
            assert.equal(result.session, null)
            assert.deepEqual(outputs, [])
            assert.equal(errors.length, 1)
            assert.match(errors[0]!, /Usage: yo \[/)
            assert.doesNotMatch(errors[0]!, /yo ask/)
            assert.doesNotMatch(errors[0]!, /yo chat/)
        })
    }
})

test('reports non-secret OAuth account and expiry status', async (context) => {
    const privateAccessToken = 'private-access-token'
    const privateRefreshToken = 'private-refresh-token'
    const cases = [
        {
            name: 'valid access token',
            expiresAt: 4_000_000_000_000,
            tokenStatus: 'valid',
        },
        {
            name: 'expired access token',
            expiresAt: 0,
            tokenStatus: 'expired',
        },
    ] as const

    for (const testCase of cases) {
        await context.test(testCase.name, async () => {
            const credential = {
                type: 'oauth',
                accessToken: privateAccessToken,
                refreshToken: privateRefreshToken,
                expiresAt: testCase.expiresAt,
                accountId: 'account-id',
            } as const satisfies Credential
            const { errors, outputs, result } = await invokeCli({
                argv: ['auth', 'status'],
                credentialStore: {
                    read: async (providerId) => {
                        assert.equal(providerId, OPENAI_CODEX_PROVIDER_ID)
                        return credential
                    },
                    modify: async () => credential,
                    delete: async () => {},
                },
            })

            assert.deepEqual(result, { exitCode: 0, session: null })
            assert.deepEqual(errors, [])
            assert.deepEqual(outputs, [
                [
                    'Authentication: signed in',
                    'Provider: openai-codex',
                    'Account ID: account-id',
                    `Expires at: ${new Date(testCase.expiresAt).toISOString()}`,
                    `Access token: ${testCase.tokenStatus}`,
                ].join('\n'),
            ])
            assert.doesNotMatch(
                `${outputs.join('\n')}\n${errors.join('\n')}`,
                /private-access-token|private-refresh-token/
            )
        })
    }
})

test('reports a missing OAuth credential without failing', async () => {
    const { errors, outputs, result } = await invokeCli({
        argv: ['auth', 'status'],
        credentialStore: {
            read: async () => undefined,
            modify: async () => undefined,
            delete: async () => {},
        },
    })

    assert.deepEqual(result, { exitCode: 0, session: null })
    assert.deepEqual(errors, [])
    assert.deepEqual(outputs, ['Not signed in. Run yo login.'])
})

test('logs out idempotently through the credential store', async () => {
    let storedCredential: Credential | undefined = {
        type: 'oauth',
        accessToken: 'private-access-token',
        refreshToken: 'private-refresh-token',
        expiresAt: 4_000_000_000_000,
        accountId: 'account-id',
    }
    let deleteCount = 0
    const credentialStore: CredentialStore = {
        read: async () => storedCredential,
        modify: async () => storedCredential,
        delete: async (providerId) => {
            assert.equal(providerId, OPENAI_CODEX_PROVIDER_ID)
            storedCredential = undefined
            deleteCount += 1
        },
    }

    for (let invocation = 1; invocation <= 2; invocation += 1) {
        const { errors, outputs, result } = await invokeCli({
            argv: ['logout'],
            credentialStore,
        })

        assert.deepEqual(result, { exitCode: 0, session: null })
        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, ['Signed out of OpenAI Codex.'])
        assert.equal(storedCredential, undefined)
        assert.equal(deleteCount, invocation)
    }
})

test('sanitizes OAuth credential store failures', async (context) => {
    await context.test('status read failure', async () => {
        const { errors, outputs, result } = await invokeCli({
            argv: ['auth', 'status'],
            credentialStore: {
                read: async () => {
                    throw new Error('private-access-token in malformed auth file')
                },
                modify: async () => undefined,
                delete: async () => {},
            },
        })

        assert.deepEqual(result, { exitCode: 1, session: null })
        assert.deepEqual(outputs, [])
        assert.deepEqual(errors, ['Cannot read OAuth authentication status.'])
        assert.doesNotMatch(errors.join('\n'), /private-access-token|malformed auth file/)
    })

    await context.test('logout delete failure', async () => {
        const { errors, outputs, result } = await invokeCli({
            argv: ['logout'],
            credentialStore: {
                read: async () => undefined,
                modify: async () => undefined,
                delete: async () => {
                    throw new Error('private-refresh-token in locked auth file')
                },
            },
        })

        assert.deepEqual(result, { exitCode: 1, session: null })
        assert.deepEqual(outputs, [])
        assert.deepEqual(errors, ['Cannot remove OAuth credential.'])
        assert.doesNotMatch(errors.join('\n'), /private-refresh-token|locked auth file/)
    })
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
    const credential = {
        type: 'oauth' as const,
        accessToken: 'private-access-token',
        refreshToken: 'private-refresh-token',
        expiresAt: 1_800_000_000_000,
        accountId: 'account-id',
    }
    let storedCredential: Credential | undefined

    const result = await runCli(['login'], {
        transport: async () => {
            throw new Error('transport not provided')
        },
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
        exchangeCredential: async (options) => {
            assert.deepEqual(options, {
                code: 'authorization-code',
                codeVerifier: authorization.codeVerifier,
            })
            return credential
        },
        credentialStore: {
            read: async () => storedCredential,
            modify: async (_providerId, update) => {
                storedCredential = await update(storedCredential)
                return storedCredential
            },
            delete: async () => {},
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
        'Signed in successfully.',
    ])
    assert.equal(result.exitCode, 0)
    assert.equal(result.session, null)
    assert.doesNotMatch(
        `${outputs.join('\n')}\n${errors.join('\n')}`,
        /private-verifier|authorization-code|private-access-token|private-refresh-token/
    )
    assert.deepEqual(storedCredential, credential)
})

test('completes browser login through injected HTTP and a temporary credential store', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-login-flow-'))
    const authPath = join(fixtureRoot, '.yo', 'auth.json')
    const credentialStore = createFileCredentialStore({ authPath })
    const authorizationCode = 'private-authorization-code'
    const accessToken = [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(
            JSON.stringify({
                [OPENAI_CODEX_AUTH_CLAIM]: {
                    chatgpt_account_id: 'account-id',
                },
            })
        ).toString('base64url'),
        'signature',
    ].join('.')
    const refreshToken = 'private-refresh-token'
    const now = 1_700_000_000_000
    const outputs: string[] = []
    const errors: string[] = []
    let listenOptions: CallbackServerListenOptions | undefined
    let callbackStatusCode: number | undefined
    let closeCount = 0
    let tokenRequest: { input: string; init: RequestInit | undefined } | undefined

    try {
        const result = await runCli(['login'], {
            transport: async () => {
                throw new Error('transport not provided')
            },
            startCallbackListener: (options) =>
                startOpenAICodexCallbackListener({
                    ...options,
                    listen: async (options) => {
                        listenOptions = options
                        return {
                            close: async () => {
                                closeCount += 1
                            },
                        }
                    },
                }),
            exchangeCredential: ({ code, codeVerifier }) =>
                exchangeOpenAICodexAuthorizationCode({
                    code,
                    codeVerifier,
                    now: () => now,
                    fetch: async (input, init) => {
                        tokenRequest = { input: input.toString(), init }
                        return new Response(
                            JSON.stringify({
                                access_token: accessToken,
                                refresh_token: refreshToken,
                                expires_in: 3_600,
                            }),
                            { status: 200 }
                        )
                    },
                }),
            credentialStore,
            writeOutput: (message) => {
                outputs.push(message)

                if (message.startsWith('Open this URL in your browser:\n')) {
                    const authorizationUrl = new URL(message.split('\n')[1]!)
                    callbackStatusCode = listenOptions?.onRequest({
                        requestUrl: `/auth/callback?code=${authorizationCode}&state=${authorizationUrl.searchParams.get('state')}`,
                    }).statusCode
                }
            },
            writeError: (message) => errors.push(message),
        })
        const authorizationUrl = new URL(outputs[0]!.split('\n')[1]!)
        const requestBody = new URLSearchParams(tokenRequest?.init?.body?.toString())
        const codeVerifier = requestBody.get('code_verifier')
        const expectedCredential = {
            type: 'oauth',
            accessToken,
            refreshToken,
            expiresAt: now + 3_600_000,
            accountId: 'account-id',
        } as const satisfies Credential

        assert.deepEqual(result, { exitCode: 0, session: null })
        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, [
            `Open this URL in your browser:\n${authorizationUrl.toString()}`,
            'Signed in successfully.',
        ])
        assert.equal(callbackStatusCode, 204)
        assert.equal(closeCount, 1)
        assert.equal(tokenRequest?.input, 'https://auth.openai.com/oauth/token')
        assert.equal(tokenRequest?.init?.method, 'POST')
        assert.equal(requestBody.get('code'), authorizationCode)
        assert.notEqual(codeVerifier, null)
        assert.equal(
            createHash('sha256').update(codeVerifier!, 'utf8').digest('base64url'),
            authorizationUrl.searchParams.get('code_challenge')
        )
        assert.deepEqual(await credentialStore.read(OPENAI_CODEX_PROVIDER_ID), expectedCredential)
        assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {
            [OPENAI_CODEX_PROVIDER_ID]: expectedCredential,
        })

        const cliMessages = `${outputs.join('\n')}\n${errors.join('\n')}`

        for (const secret of [authorizationCode, codeVerifier!, accessToken, refreshToken]) {
            assert.equal(cliMessages.includes(secret), false)
        }
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('does not persist a credential when its exchange fails', async () => {
    let modifyCalled = false
    const { errors, outputs, result } = await invokeCli({
        argv: ['login'],
        createAuthorization: () => ({
            authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=public-state',
            codeVerifier: 'private-verifier',
            state: 'public-state',
        }),
        startCallbackListener: async () => ({
            waitForCallback: async () => ({ status: 'accepted', code: 'authorization-code' }),
            close: async () => {},
        }),
        exchangeCredential: async () => {
            throw new Error('private token response')
        },
        credentialStore: {
            read: async () => undefined,
            modify: async () => {
                modifyCalled = true
                return undefined
            },
            delete: async () => {},
        },
    })

    assert.deepEqual(outputs, [
        'Open this URL in your browser:\nhttps://auth.openai.com/oauth/authorize?state=public-state',
    ])
    assert.deepEqual(errors, ['OAuth credential exchange failed. Run yo login again.'])
    assert.deepEqual(result, { exitCode: 1, session: null })
    assert.equal(modifyCalled, false)
    assert.doesNotMatch(
        `${outputs.join('\n')}\n${errors.join('\n')}`,
        /authorization-code|private token/
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
        argv: ['--cwd', '/missing/yo-workspace'],
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
    const lines = ['Find the answer.', '/exit']
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

        const { answers, errors, outputs, result } = await invokeCli({
            argv: ['--cwd', workspace],
            transport,
            createLineInput: () => ({
                readLine: async () => lines.shift() ?? null,
                close: () => undefined,
            }),
        })

        assert.deepEqual(answers, ['The answer is in src/agent.ts.\n\n'])
        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 0)
        assert.deepEqual(outputs, [
            [
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
    const lines = ['Find the default timeout and cite its definition.', '/exit']
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

        const { answers, errors, outputs, result } = await invokeCli({
            argv: ['--cwd', workspace],
            transport,
            createLineInput: () => ({
                readLine: async () => lines.shift() ?? null,
                close: () => undefined,
            }),
        })

        assert.deepEqual(answers, ['The default timeout is 5,000 ms in src/settings.ts:1.\n\n'])
        assert.deepEqual(errors, [])
        assert.deepEqual(outputs, [
            [
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

test('completes an inspected, approved patch through chat and reports its exact outcome', async () => {
    const fixtureRoot = await mkdtemp(`${tmpdir()}/yo-cli-patch-e2e-`)
    const workspace = join(fixtureRoot, 'workspace')
    const sourceDirectory = join(workspace, 'src')
    const sourcePath = join(sourceDirectory, 'settings.ts')
    const source = 'export const defaultTimeoutMs = 5_000\n'
    const nextSource = 'export const defaultTimeoutMs = 10_000\n'
    const lines = ['Increase the timeout after inspecting its definition.', 'yes', '/exit']
    const requests: ModelRequest[] = []
    let approvalPromptCount = 0
    let inputClosed = false

    const transport: ModelTransport = async (request) => {
        requests.push(request)

        if (requests.length === 1) {
            return {
                type: 'tool_calls',
                model: 'faux-model',
                toolCalls: [
                    {
                        id: 'read-settings',
                        name: 'read_file',
                        arguments: { path: 'src/settings.ts' },
                    },
                ],
            }
        }

        if (requests.length === 2) {
            assert.deepEqual(request.messages.at(-1), {
                role: 'tool',
                result: {
                    status: 'success',
                    callId: 'read-settings',
                    content: '1:export const defaultTimeoutMs = 5_000',
                    metadata: { truncated: false, truncation: null },
                },
            })

            return {
                type: 'tool_calls',
                model: 'faux-model',
                toolCalls: [
                    {
                        id: 'patch-settings',
                        name: 'propose_patch',
                        arguments: {
                            path: 'src/settings.ts',
                            edits: [{ oldText: '5_000', newText: '10_000' }],
                        },
                    },
                ],
            }
        }

        assert.deepEqual(request.messages.at(-1), {
            role: 'tool',
            result: {
                status: 'success',
                callId: 'patch-settings',
                content: 'Patch applied: src/settings.ts',
                metadata: { truncated: false, truncation: null },
            },
        })

        return {
            type: 'final_answer',
            model: 'faux-model',
            content: 'Updated src/settings.ts after approval.',
        }
    }

    try {
        await mkdir(sourceDirectory, { recursive: true })
        await writeFile(sourcePath, source)

        const { answers, errors, outputs, result } = await invokeCli({
            argv: ['--cwd', workspace],
            transport,
            isInteractive: true,
            createLineInput: () => ({
                readLine: async (prompt) => {
                    const line = lines.shift() ?? null

                    if (prompt === PATCH_APPROVAL_PROMPT) {
                        approvalPromptCount += 1
                    } else {
                        assert.equal(prompt, CHAT_PROMPT)
                    }

                    return line
                },
                close: () => {
                    inputClosed = true
                },
            }),
        })

        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'completed')
        assert.equal(result.session?.stopReason, 'final_answer')
        assert.equal(approvalPromptCount, 1)
        assert.equal(inputClosed, true)
        assert.equal(requests.length, 3)
        const renderedAnswer = answers.join('')
        assert.ok(renderedAnswer.includes('Patch proposal: src/settings.ts'))
        assert.ok(renderedAnswer.includes('--- src/settings.ts'))
        assert.ok(renderedAnswer.includes('+++ src/settings.ts'))
        assert.ok(renderedAnswer.includes('-export const defaultTimeoutMs = 5_000'))
        assert.ok(renderedAnswer.includes('+export const defaultTimeoutMs = 10_000'))
        assert.equal(renderedAnswer.includes(PATCH_APPROVAL_PROMPT), false)
        assert.ok(renderedAnswer.includes('Updated src/settings.ts after approval.'))
        assert.deepEqual(outputs, [
            [
                'Evidence:',
                'Stop reason: final_answer',
                'Tools: read_file, propose_patch',
                'Files:',
                '- src/settings.ts',
                'Patches:',
                '- src/settings.ts: applied',
            ].join('\n'),
        ])
        assert.equal(await readFile(sourcePath, 'utf8'), nextSource)
        assert.deepEqual(await readdir(workspace), ['src'])
        assert.deepEqual(await readdir(sourceDirectory), ['settings.ts'])
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('prints a failed report after step-budget exhaustion without authorized evidence', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-budget-`)
    const lines = ['Inspect the workspace.', '/exit']
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
        const { answers, errors, outputs, result } = await invokeCli({
            argv: ['--cwd', workspace],
            transport,
            createLineInput: () => ({
                readLine: async () => lines.shift() ?? null,
                close: () => undefined,
            }),
        })

        assert.deepEqual(answers, [])
        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.stopReason, 'step_budget_exhausted')
        assert.deepEqual(outputs, [
            [
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

test('renders a chat patch preview but denies it in non-interactive mode', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-chat-non-interactive-`)
    const sourcePath = join(workspace, 'example.ts')
    const lines = ['Update the value.', '/exit']
    let requestCount = 0
    const transport: ModelTransport = async () => {
        requestCount += 1

        return requestCount === 1
            ? {
                  type: 'tool_calls',
                  model: null,
                  toolCalls: [
                      {
                          id: 'patch-call',
                          name: 'propose_patch',
                          arguments: {
                              path: 'example.ts',
                              edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
                          },
                      },
                  ],
              }
            : {
                  type: 'final_answer',
                  model: null,
                  content: 'Patch was not applied.',
              }
    }

    try {
        await writeFile(sourcePath, 'export const value = 1\n')
        const { answers, errors, result } = await invokeCli({
            argv: ['--cwd', workspace],
            transport,
            isInteractive: false,
            createLineInput: () => ({
                readLine: async () => lines.shift() ?? null,
                close: () => undefined,
            }),
        })

        assert.deepEqual(errors, [])
        assert.equal(result.exitCode, 0)
        assert.equal(await readFile(sourcePath, 'utf8'), 'export const value = 1\n')
        const renderedAnswer = answers.join('')
        assert.ok(renderedAnswer.includes('Patch proposal: example.ts'))
        assert.ok(renderedAnswer.includes('Apply this patch? [y/N] \n'))
        assert.equal(
            result.session?.messages.some(
                (message) => message.role === 'tool' && message.result.status === 'denied'
            ),
            true
        )
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})

test('reuses the active chat input for approval without adding an approval response to the conversation', async () => {
    const workspace = await mkdtemp(`${tmpdir()}/yo-cli-chat-approval-`)
    const sourcePath = join(workspace, 'example.ts')
    const lines = ['Update the value.', 'y', '/exit']
    const prompts: string[] = []
    const requests: ModelRequest[] = []
    let lineIndex = 0
    let createdInputs = 0
    let closeCount = 0
    const input: LineInput = {
        readLine: async (prompt) => {
            prompts.push(prompt)
            const line = lines[lineIndex]
            lineIndex += 1
            return line ?? null
        },
        close: () => {
            closeCount += 1
        },
    }
    const transport: ModelTransport = async (request) => {
        requests.push(request)

        if (requests.length === 1) {
            return {
                type: 'tool_calls',
                model: null,
                toolCalls: [
                    {
                        id: 'patch-call',
                        name: 'propose_patch',
                        arguments: {
                            path: 'example.ts',
                            edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
                        },
                    },
                ],
            }
        }

        return {
            type: 'final_answer',
            model: null,
            content: 'Patch applied.',
        }
    }

    try {
        await writeFile(sourcePath, 'export const value = 1\n')
        const { errors, result } = await invokeCli({
            argv: ['--cwd', workspace],
            transport,
            createLineInput: () => {
                createdInputs += 1
                return input
            },
            isInteractive: true,
        })

        assert.deepEqual(errors, [])
        assert.equal(createdInputs, 1)
        assert.equal(closeCount, 1)
        assert.equal(result.exitCode, 0)
        assert.equal(await readFile(sourcePath, 'utf8'), 'export const value = 2\n')
        assert.deepEqual(prompts, [CHAT_PROMPT, PATCH_APPROVAL_PROMPT, CHAT_PROMPT])
        assert.equal(
            requests.every((request) =>
                request.messages.some(
                    (message) => message.role === 'user' && message.content === 'Update the value.'
                )
            ),
            true
        )
        assert.equal(
            requests[1]?.messages.some(
                (message) => message.role === 'user' && message.content === 'y'
            ),
            false
        )
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})
