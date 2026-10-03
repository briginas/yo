import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runCli, type CliDependencies } from './cli-app.ts'
import { runConversationTurn } from './runtime/conversation.ts'
import type { ModelRequest, ModelTransport } from './runtime/run.ts'
import { PATCH_APPROVAL_PROMPT } from './terminal-approval.ts'

const startTime = new Date(2026, 9, 2, 12, 0, 0).getTime()
const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}
const fixture = async (
    lines: string[],
    transport: ModelTransport,
    overrides: Partial<CliDependencies> = {}
) => {
    const workspace = await mkdtemp(join(tmpdir(), 'yo-observation-'))
    const output: string[] = [],
        statuses: string[] = [],
        answers: string[] = [],
        errors: string[] = []
    const dependencies: CliDependencies = {
        transport,
        writeOutput: (message) => output.push(message),
        writeError: (message) => errors.push(message),
        writeAnswer: (message) => answers.push(message),
        writeStatus: (message) => statuses.push(message),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: false,
        createLineInput: () => ({
            readLine: async () => lines.shift() ?? null,
            close: () => undefined,
        }),
        observationClocks: { wallTime: () => startTime, monotonicTime: () => 100 },
        ...overrides,
    }
    return { workspace, output, statuses, answers, errors, dependencies }
}
const answer: ModelTransport = async () => ({
    type: 'final_answer',
    model: null,
    content: 'Complete answer.',
})

test('CLI prepares record and callback before invoking a synchronously emitting turn', async () => {
    const state = await fixture(['Inspect', '/exit'], answer)
    try {
        state.dependencies.runTurn = (options) => {
            assert.equal(typeof options.onEvent, 'function')
            assert.match(state.statuses[0]!, /^Run #1: Inspect/)
            const promise = runConversationTurn(options)
            // run_started and model_requested are emitted before the first awaited transport.
            assert.match(state.statuses.join(''), /event: run=1 #1 run_started/)
            assert.match(state.statuses.join(''), /event: run=1 #2 model_requested step=1/)
            assert.deepEqual(state.errors, [])
            return promise
        }
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.match(state.output[0]!, /Run #1 result: completed/)
        assert.deepEqual(state.answers, ['Complete answer.\n\n'])
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('ordinary repeated tasks keep increasing numbers across empty and rejected inspection input', async () => {
    const task = '  Same task 🧩  '
    const requests: ModelRequest[] = []
    const state = await fixture(
        [
            '/runs',
            '/run 1',
            '/run 0',
            '  ',
            task,
            '/run 99',
            '/run 1',
            '/runs extra',
            task,
            '/exit',
        ],
        async (request) => {
            requests.push(structuredClone(request))
            return { type: 'final_answer', model: null, content: 'Answer.' }
        }
    )
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.equal(requests.length, 2)
        assert.deepEqual(
            requests[1]?.messages.filter((message) => message.role === 'user'),
            [
                { role: 'user', content: task },
                { role: 'user', content: task },
            ]
        )
        assert.deepEqual(
            state.statuses
                .filter((text) => text.startsWith('Run #'))
                .map((text) => /^Run #(\d+):/.exec(text)?.[1]),
            ['1', '2']
        )
        assert.match(state.output[0]!, /No runs yet/)
        assert.match(state.output[0]!, /Inspect: \/run N \| List: \/runs \| Rerun: \/rerun N/)
        assert.match(state.output[1]!, /Run #1 is unavailable/)
        assert.match(state.output[1]!, /Rerun: \/rerun N/)
        assert.match(state.output.at(-1)!, /Run #2 result: completed/)
        assert.match(state.output.at(-1)!, /Rerun: \/rerun N/)
        assert.doesNotMatch(state.output.join(''), /Run #3|#3 Same task/)
        assert.deepEqual(state.errors, [])
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('multiple turns produce ordered session list and safe errors without modifying model messages', async () => {
    const requests: ModelRequest[] = []
    let time = 100
    const transport: ModelTransport = async (request) => {
        requests.push(structuredClone(request))
        time += 25
        if (requests.length === 1)
            return {
                type: 'tool_calls',
                model: null,
                toolCalls: [
                    {
                        id: 'Bearer private-id',
                        name: 'read_file',
                        arguments: { path: 'missing.ts' },
                    },
                ],
            }
        if (requests.length === 2)
            return { type: 'final_answer', model: null, content: 'The file is missing.' }
        throw new Error('Bearer private transport diagnostics')
    }
    const state = await fixture(['Inspect missing file', 'Try another task', '/exit'], transport, {
        observationClocks: { wallTime: () => startTime - time, monotonicTime: () => time },
    })
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.match(state.output[0]!, /Run #1 result: completed/)
        assert.match(state.output[0]!, /execution_error step=1 call=1/)
        assert.match(state.output[1]!, /Run #2 result: failed/)
        assert.match(state.output[1]!, /transport_error/)
        assert.match(state.output[1]!, /#1 Inspect missing file \| completed/)
        assert.match(state.output[1]!, /#2 Try another task \| failed/)
        assert.match(state.output[1]!, /elapsed=0.050s/)
        assert.deepEqual(
            requests[2]?.messages.map((message) => message.role),
            ['system', 'user', 'assistant', 'tool', 'assistant', 'user']
        )
        assert.deepEqual(requests[2]?.messages.at(-1), {
            role: 'user',
            content: 'Try another task',
        })
        const visible = [...state.output, ...state.statuses, ...state.errors].join('')
        assert.doesNotMatch(visible, /Bearer|private|status: model_waiting|status: tool_/)
        assert.equal((state.statuses.join('').match(/tool_completed/g) ?? []).length, 1)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('full answer is delivered exactly once despite a truncated observation preview', async () => {
    const content = 'x'.repeat(20000)
    const state = await fixture(['Long answer', '/exit'], async (_request, options) => {
        options?.onFinalAnswerDelta?.(content.slice(0, 10000))
        options?.onFinalAnswerDelta?.(content.slice(10000))
        return { type: 'final_answer', model: null, content }
    })
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.session?.finalAnswer, content)
        assert.equal(state.answers.join(''), `${content}\n\n`)
        assert.doesNotMatch(state.output.join(''), /xxx/)
        assert.doesNotMatch(state.statuses.join(''), /xxx|final_answer_delta/)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('display and diagnostic output failures preserve successful transcript and result', async () => {
    const requests: ModelRequest[] = []
    const state = await fixture(['First', 'Second', '/exit'], async (request) => {
        requests.push(structuredClone(request))
        return { type: 'final_answer', model: null, content: 'Answer.' }
    })
    state.dependencies.writeStatus = () => {
        throw new Error('Bearer private display')
    }
    state.dependencies.writeOutput = () => {
        throw new Error('Bearer private card')
    }
    state.dependencies.writeError = () => {
        throw new Error('Bearer private diagnostic')
    }
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.status, 'completed')
        assert.deepEqual(state.answers, ['Answer.\n\n', 'Answer.\n\n'])
        assert.deepEqual(
            requests[1]?.messages.map((message) => message.role),
            ['system', 'user', 'assistant', 'user']
        )
        assert.deepEqual(requests[1]?.messages[2], {
            role: 'assistant',
            content: 'Answer.',
            toolCalls: [],
        })
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('unexpected turn invocation failure prints settled CLI failure and freezes history', async () => {
    const state = await fixture(['First', '/exit'], answer, {
        runTurn: async () => {
            throw new Error('Bearer private invocation error')
        },
    })
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 1)
        assert.equal(result.session, null)
        assert.match(state.output[0]!, /Run #1 result: failed/)
        assert.match(state.output[0]!, /Stop reason: cli_turn_error/)
        assert.match(state.output[0]!, /#1 First \| failed/)
        assert.deepEqual(state.errors, ['Chat turn failed.'])
        assert.doesNotMatch(state.output.join(''), /transport_error|Bearer|private/)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('controlled delayed model request updates time on events and settles after the promise gate', async () => {
    const waiting = deferred<void>(),
        response = deferred<void>()
    let time = 100
    const state = await fixture(
        ['Wait', '/exit'],
        async () => {
            waiting.resolve()
            await response.promise
            return { type: 'final_answer', model: null, content: 'Finished.' }
        },
        { observationClocks: { wallTime: () => startTime, monotonicTime: () => time } }
    )
    try {
        const run = runCli(['--cwd', state.workspace], state.dependencies)
        await waiting.promise
        assert.match(state.statuses.join(''), /state: run=1 model elapsed=0.000s/)
        assert.equal(state.output.length, 0)
        time = 350
        response.resolve()
        await run
        assert.match(state.output[0]!, /Elapsed: 0.250s/)
        assert.match(state.output[0]!, /completed/)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('waiting for exact patch consent remains exclusive and displays approved/application or denial/conflict', async (context) => {
    for (const outcome of ['applied', 'denied', 'conflict'] as const) {
        await context.test(outcome, async () => {
            const waiting = deferred<void>(),
                approval = deferred<string>()
            let modelStep = 0
            const requests: ModelRequest[] = []
            const prompts: string[] = []
            const lines = ['Change answer', '/exit']
            const state = await fixture(
                lines,
                async (request) => {
                    requests.push(structuredClone(request))
                    if (modelStep++ === 0)
                        return {
                            type: 'tool_calls',
                            model: null,
                            toolCalls: [
                                {
                                    id: 'patch',
                                    name: 'propose_patch',
                                    arguments: {
                                        path: 'answer.ts',
                                        edits: [{ oldText: '42', newText: '43' }],
                                    },
                                },
                            ],
                        }
                    return { type: 'final_answer', model: null, content: 'Patch outcome recorded.' }
                },
                { isInteractive: true }
            )
            state.dependencies.createLineInput = () => ({
                readLine: async (prompt) => {
                    prompts.push(prompt)
                    if (prompt === PATCH_APPROVAL_PROMPT) {
                        waiting.resolve()
                        return approval.promise
                    }
                    return lines.shift() ?? null
                },
                close: () => undefined,
            })
            try {
                await writeFile(join(state.workspace, 'answer.ts'), 'export const answer = 42\n')
                const run = runCli(['--cwd', state.workspace], state.dependencies)
                await waiting.promise
                assert.match(state.statuses.join(''), /patch_approval_requested.*outcome=waiting/)
                assert.match(state.statuses.join(''), /state: run=1 approval/)
                assert.match(state.answers.join(''), /--- answer.ts\n\+\+\+ answer.ts/)
                assert.match(
                    state.answers.join(''),
                    /-export const answer = 42\n\+export const answer = 43/
                )
                assert.equal(state.output.length, 0)
                if (outcome === 'conflict')
                    await writeFile(join(state.workspace, 'answer.ts'), 'external change\n')
                approval.resolve(outcome === 'denied' ? 'n' : 'y')
                const result = await run
                assert.equal(result.exitCode, 0)
                assert.match(
                    state.output[0]!,
                    outcome === 'applied'
                        ? /waiting -> approved -> applied/
                        : outcome === 'denied'
                          ? /waiting -> denied/
                          : /waiting -> approved -> conflict \(base_changed\)/
                )
                assert.equal(prompts.filter((prompt) => prompt === PATCH_APPROVAL_PROMPT).length, 1)
                assert.deepEqual(
                    requests[1]?.messages.filter((message) => message.role === 'user'),
                    [{ role: 'user', content: 'Change answer' }]
                )
                assert.equal(
                    await readFile(join(state.workspace, 'answer.ts'), 'utf8'),
                    outcome === 'applied'
                        ? 'export const answer = 43\n'
                        : outcome === 'denied'
                          ? 'export const answer = 42\n'
                          : 'external change\n'
                )
                assert.equal(
                    result.session?.events.filter((event) => event.type === 'tool_completed')
                        .length,
                    1
                )
            } finally {
                await rm(state.workspace, { recursive: true, force: true })
            }
        })
    }
})

test('settlement timing is frozen before answer output and output failure cannot skip the result', async () => {
    let time = 100
    const state = await fixture(
        ['Inspect', '/exit'],
        async () => {
            time = 200
            return { type: 'final_answer', model: null, content: 'Answer.' }
        },
        { observationClocks: { wallTime: () => startTime, monotonicTime: () => time } }
    )
    state.dependencies.writeAnswer = () => {
        time = 5000
        throw new Error('Bearer private output failure')
    }
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.finalAnswer, 'Answer.')
        assert.match(state.output[0]!, /Elapsed: 0.100s/)
        assert.deepEqual(state.errors, ['Observation: answer observer failed.'])
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('patch approval abort is recorded without inferring cancellation of the whole run', async () => {
    let step = 0
    const state = await fixture(
        ['Propose edit', '/exit'],
        async () =>
            step++ === 0
                ? {
                      type: 'tool_calls',
                      model: null,
                      toolCalls: [
                          {
                              id: 'patch',
                              name: 'propose_patch',
                              arguments: {
                                  path: 'answer.ts',
                                  edits: [{ oldText: '42', newText: '43' }],
                              },
                          },
                      ],
                  }
                : { type: 'final_answer', model: null, content: 'Approval was aborted.' },
        {
            runTurn: (options) =>
                runConversationTurn({ ...options, patchApprover: async () => 'aborted' }),
        }
    )
    try {
        await writeFile(join(state.workspace, 'answer.ts'), 'export const answer = 42\n')
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.session?.status, 'completed')
        assert.match(state.output[0]!, /waiting -> aborted/)
        assert.match(state.output[0]!, /Run #1 result: completed/)
        assert.equal(
            await readFile(join(state.workspace, 'answer.ts'), 'utf8'),
            'export const answer = 42\n'
        )
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('real line-limited read warns on its own call while normal read and model observations stay unchanged', async () => {
    const requests: ModelRequest[] = []
    const state = await fixture(['Read both files', '/exit'], async (request) => {
        requests.push(structuredClone(request))
        if (requests.length === 1)
            return {
                type: 'tool_calls',
                model: null,
                toolCalls: [
                    { id: 'long-read', name: 'read_file', arguments: { path: 'long.txt' } },
                    { id: 'short-read', name: 'read_file', arguments: { path: 'short.txt' } },
                ],
            }
        return { type: 'final_answer', model: null, content: 'The first read was limited.' }
    })
    try {
        const longContent = Array.from(
            { length: 2001 },
            (_, index) => `fixture_line_${index + 1}`
        ).join('\n')
        await writeFile(join(state.workspace, 'long.txt'), longContent)
        await writeFile(join(state.workspace, 'short.txt'), 'short fixture\n')
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        const completionRows = state.statuses.filter((line) => line.includes(' tool_completed '))
        assert.deepEqual(completionRows, [
            'event: run=1 #6 tool_completed step=1 call=1 tool=read_file outcome=success truncated=true reason=line_limit limit=2000 observed=2001\n',
            'event: run=1 #9 tool_completed step=1 call=2 tool=read_file outcome=success\n',
        ])
        assert.equal(state.statuses.filter((line) => line.includes('truncated=true')).length, 1)
        const runtimeResults = result
            .session!.events.filter((event) => event.type === 'tool_completed')
            .map((event) => event.result)
        const modelResults = requests[1]!.messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.result)
        assert.deepEqual(modelResults, runtimeResults)
        assert.deepEqual(runtimeResults[0]!.metadata, {
            truncated: true,
            truncation: { reason: 'line_limit', limit: 2000, observed: 2001 },
        })
        assert.deepEqual(runtimeResults[1]!.metadata, { truncated: false, truncation: null })
        assert.equal(runtimeResults[0]!.content.split('\n').length, 2000)
        assert.doesNotMatch(runtimeResults[0]!.content, /fixture_line_2001/)
        assert.equal(await readFile(join(state.workspace, 'long.txt'), 'utf8'), longContent)
        assert.doesNotMatch(
            [...state.output, ...state.statuses].join(''),
            /fixture_line_|short fixture|long-read|short-read/
        )
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.answers, ['The first read was limited.\n\n'])
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('one-off progress cleanup failures cannot erase streamed answer text in a visible terminal', async (context) => {
    for (const failingOperation of ['clear_line', 'cursor_to_start'] as const) {
        await context.test(failingOperation, async () => {
            const rows: string[][] = [[]]
            let row = 0,
                column = 0
            const terminalWrite = (text: string): void => {
                for (const character of text) {
                    if (character === '\n') {
                        row++
                        column = 0
                        rows[row] ??= []
                    } else if (character === '\r') {
                        column = 0
                    } else {
                        const current = rows[row]!
                        while (current.length < column) current.push(' ')
                        current[column++] = character
                    }
                }
            }
            const visibleText = (): string => rows.map((line) => line.join('')).join('\n')
            let armed = false,
                failureCount = 0,
                requestCount = 0
            const requests: ModelRequest[] = []
            const maybeFail = (operation: typeof failingOperation): void => {
                if (armed && failureCount === 0 && operation === failingOperation) {
                    failureCount++
                    throw new Error('private cleanup failure')
                }
            }
            const lines = ['Stream answer', 'Propose change', 'y', '/exit']
            const state = await fixture(
                lines,
                async (request, options) => {
                    requests.push(structuredClone(request))
                    if (requestCount++ === 0) {
                        armed = true
                        options?.onFinalAnswerDelta?.('HELLO ')
                        options?.onFinalAnswerDelta?.('WORLD')
                        return { type: 'final_answer', model: null, content: 'HELLO WORLD' }
                    }
                    if (requestCount === 2)
                        return {
                            type: 'tool_calls',
                            model: null,
                            toolCalls: [
                                {
                                    id: 'patch',
                                    name: 'propose_patch',
                                    arguments: {
                                        path: 'answer.ts',
                                        edits: [{ oldText: '42', newText: '43' }],
                                    },
                                },
                            ],
                        }
                    return { type: 'final_answer', model: null, content: 'Patch applied.' }
                },
                { isInteractive: true }
            )
            const prompts: string[] = []
            state.dependencies.createLineInput = () => ({
                readLine: async (prompt) => {
                    prompts.push(prompt)
                    return lines.shift() ?? null
                },
                close: () => undefined,
            })
            state.dependencies.writeStatus = terminalWrite
            state.dependencies.writeAnswer = (message) => {
                state.answers.push(message)
                terminalWrite(message)
            }
            state.dependencies.writeOutput = (message) => {
                state.output.push(message)
                terminalWrite(`${message}\n`)
            }
            state.dependencies.clearStatusLine = () => {
                maybeFail('clear_line')
                rows[row] = []
            }
            state.dependencies.moveStatusCursorToStart = () => {
                maybeFail('cursor_to_start')
                column = 0
            }
            try {
                await writeFile(join(state.workspace, 'answer.ts'), 'export const answer = 42\n')
                const result = await runCli(['--cwd', state.workspace], state.dependencies)
                assert.equal(result.exitCode, 0)
                assert.equal(failureCount, 1)
                const rendered = visibleText()
                assert.match(rendered, /HELLO WORLD/)
                assert.equal((rendered.match(/HELLO WORLD/g) ?? []).length, 1)
                assert.equal((rendered.match(/Patch applied\./g) ?? []).length, 1)
                assert.match(rendered, /--- answer.ts/)
                assert.match(rendered, /\+\+\+ answer.ts/)
                assert.match(rendered, /Run #2 result: completed/)
                assert.match(rendered, /waiting -> approved -> applied/)
                assert.doesNotMatch(rendered, /private cleanup failure/)
                assert.deepEqual(state.answers.slice(0, 3), ['HELLO ', 'WORLD', '\n\n'])
                assert.deepEqual(requests[1]?.messages[2], {
                    role: 'assistant',
                    content: 'HELLO WORLD',
                    toolCalls: [],
                })
                assert.equal(prompts.filter((prompt) => prompt === PATCH_APPROVAL_PROMPT).length, 1)
                assert.deepEqual(
                    requests[2]?.messages.filter((message) => message.role === 'user'),
                    [
                        { role: 'user', content: 'Stream answer' },
                        { role: 'user', content: 'Propose change' },
                    ]
                )
                assert.equal(
                    await readFile(join(state.workspace, 'answer.ts'), 'utf8'),
                    'export const answer = 43\n'
                )
                assert.deepEqual(state.errors, [])
            } finally {
                await rm(state.workspace, { recursive: true, force: true })
            }
        })
    }
})

test('inspection-only input never invokes a turn or clocks and resets between sessions', async () => {
    const state = await fixture(['/runs', '/run 1', '/run 0', '/runs extra', '/exit'], answer, {
        runTurn: async () => {
            throw new Error('unexpected turn')
        },
        observationClocks: {
            wallTime: () => {
                throw new Error('unexpected clock')
            },
            monotonicTime: () => {
                throw new Error('unexpected clock')
            },
        },
    })
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.equal(result.session, null)
        assert.deepEqual(state.errors, [])
        assert.deepEqual(state.statuses, [])
        assert.match(state.output[0]!, /No runs yet/)
        assert.match(state.output[1]!, /Run #1 is unavailable/)
        assert.match(state.output[2]!, /^Usage:/)
        assert.match(state.output[3]!, /^Usage:/)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('navigation preserves model requests, original task bytes, run IDs and clock count', async () => {
    const state = await fixture([], answer)
    const tasks = [' First ', '/runner', ' /exit ']
    try {
        const execute = async (inspect: boolean) => {
            let calls = 0
            const requests: ModelRequest[] = [],
                output: string[] = [],
                headers: string[] = []
            const lines = inspect
                ? [
                      '/runs',
                      tasks[0]!,
                      '/run 1',
                      '/run 99',
                      '/run -1',
                      tasks[1]!,
                      '/run 2',
                      '/run 1',
                      tasks[2]!,
                      '/exit',
                  ]
                : [...tasks, '/exit']
            const result = await runCli(['--cwd', state.workspace], {
                ...state.dependencies,
                createLineInput: () => ({
                    readLine: async () => lines.shift() ?? null,
                    close: () => undefined,
                }),
                observationClocks: {
                    wallTime: () => {
                        calls++
                        return startTime
                    },
                    monotonicTime: () => {
                        calls++
                        return 100
                    },
                },
                transport: async (request) => {
                    requests.push(structuredClone(request))
                    return {
                        type: 'final_answer',
                        model: null,
                        content: `Answer ${requests.length}`,
                    }
                },
                writeOutput: (text) => output.push(text),
                writeStatus: (text) => headers.push(text),
            })
            return { requests, calls, result, output, headers }
        }
        const control = await execute(false),
            inspected = await execute(true)
        assert.deepEqual(inspected.requests, control.requests)
        assert.equal(inspected.calls, control.calls)
        assert.deepEqual(inspected.result.session?.messages, control.result.session?.messages)
        assert.deepEqual(inspected.headers, control.headers)
        assert.match(inspected.output[0]!, /No runs yet/)
        const views = inspected.output.filter((text) => text.includes('Retained answer:'))
        assert.equal(views.length, 3)
        assert.equal(views[0], views[2])
        assert.match(views[1]!, /Retained answer:\nAnswer 2/)
        assert.doesNotMatch(views[1]!, /Answer 1|event: run=1/)
        assert.deepEqual(
            inspected.requests
                .at(-1)
                ?.messages.filter((m) => m.role === 'user')
                .map((m) => m.content),
            tasks
        )
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('defensive running selection is rejected without creating another run', async () => {
    let turns = 0
    const state = await fixture(['First', '/run 1', '/exit'], answer, {
        runTurn: async (options) => {
            turns++
            const result = await runConversationTurn(options)
            return {
                ...result,
                turn: {
                    ...result.turn,
                    session: { ...result.turn.session, status: 'running', stopReason: null },
                },
            }
        },
    })
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.equal(turns, 1)
        assert.match(state.output.at(-1)!, /Run #1 is not settled/)
        assert.doesNotMatch(state.output.join(''), /Retained answer:/)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('failed inspection output and diagnostics cannot submit commands or terminate following chat', async () => {
    const requests: ModelRequest[] = []
    const state = await fixture(
        ['First', '/run 1', '/runs extra', 'Second', '/run 1', '/exit'],
        async (request) => {
            requests.push(structuredClone(request))
            return { type: 'final_answer', model: null, content: `Answer ${requests.length}` }
        }
    )
    let failures = 0
    state.dependencies.writeOutput = (text) => {
        if ((text.includes('Retained answer:') || text.startsWith('Usage:')) && failures++ < 2) {
            throw new Error('Bearer private output error')
        }
        state.output.push(text)
    }
    state.dependencies.writeError = () => {
        throw new Error('private diagnostic')
    }
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.equal(result.session?.finalAnswer, 'Answer 2')
        assert.equal(requests.length, 2)
        assert.deepEqual(
            requests[1]?.messages.filter((m) => m.role === 'user').map((m) => m.content),
            ['First', 'Second']
        )
        assert.match(state.output.at(-1)!, /Retained answer:\nAnswer 1/)
        assert.doesNotMatch(state.output.join(''), /private|Bearer/)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('pending model and faux tool work never start a navigation read', async (context) => {
    for (const phase of ['model', 'tool'] as const)
        await context.test(phase, async () => {
            const waiting = deferred<void>(),
                release = deferred<void>()
            const lines = ['Task', '/runs', '/exit']
            let reads = 0
            const state = await fixture(
                lines,
                async () => {
                    if (phase === 'model') {
                        waiting.resolve()
                        await release.promise
                    }
                    return { type: 'final_answer', model: null, content: 'Done' }
                },
                {
                    createLineInput: () => ({
                        readLine: async () => {
                            reads++
                            return lines.shift() ?? null
                        },
                        close: () => undefined,
                    }),
                    runTurn: async (options) => {
                        if (phase === 'tool') {
                            options.onEvent?.({
                                type: 'tool_requested',
                                step: 1,
                                call: {
                                    id: 'gated',
                                    name: 'read_file',
                                    arguments: { path: 'file.ts' },
                                },
                            })
                            waiting.resolve()
                            await release.promise
                        }
                        return runConversationTurn(options)
                    },
                }
            )
            try {
                const run = runCli(['--cwd', state.workspace], state.dependencies)
                await waiting.promise
                assert.equal(reads, 1)
                assert.equal(state.output.length, 0)
                release.resolve()
                assert.equal((await run).exitCode, 0)
                assert.equal(reads, 3)
                assert.match(state.output.at(-1)!, /^Session runs:/)
            } finally {
                release.resolve()
                await rm(state.workspace, { recursive: true, force: true })
            }
        })
})

test('command-like approval responses deny only that patch and later inspection cannot reuse consent', async (context) => {
    for (const response of ['/runs', '/run 1'])
        await context.test(response, async () => {
            const lines = ['Patch first', response, '/run 1', 'Patch again', 'y', '/run 2', '/exit']
            const prompts: string[] = [],
                requests: ModelRequest[] = []
            let step = 0
            const state = await fixture(
                lines,
                async (request) => {
                    requests.push(structuredClone(request))
                    if (step++ % 2 === 0)
                        return {
                            type: 'tool_calls',
                            model: null,
                            toolCalls: [
                                {
                                    id: `patch-${step}`,
                                    name: 'propose_patch',
                                    arguments: {
                                        path: 'answer.ts',
                                        edits: [{ oldText: '42', newText: '43' }],
                                    },
                                },
                            ],
                        }
                    return { type: 'final_answer', model: null, content: 'Recorded.' }
                },
                { isInteractive: true }
            )
            state.dependencies.createLineInput = () => ({
                readLine: async (prompt) => {
                    prompts.push(prompt)
                    if (
                        prompts.filter((p) => p === PATCH_APPROVAL_PROMPT).length === 1 &&
                        prompt === 'yo> '
                    ) {
                        assert.equal(
                            await readFile(join(state.workspace, 'answer.ts'), 'utf8'),
                            'export const answer = 42\n'
                        )
                    }
                    return lines.shift() ?? null
                },
                close: () => undefined,
            })
            try {
                await writeFile(join(state.workspace, 'answer.ts'), 'export const answer = 42\n')
                const result = await runCli(['--cwd', state.workspace], state.dependencies)
                assert.equal(result.exitCode, 0)
                assert.equal(prompts.filter((p) => p === PATCH_APPROVAL_PROMPT).length, 2)
                assert.equal(requests.length, 4)
                assert.deepEqual(
                    requests
                        .at(-1)
                        ?.messages.filter((m) => m.role === 'user')
                        .map((m) => m.content),
                    ['Patch first', 'Patch again']
                )
                const views = state.output.filter((s) => s.includes('Retained answer:'))
                assert.equal(views.length, 2)
                assert.match(views[0]!, /prepared -> waiting -> denied/)
                assert.doesNotMatch(views[0]!, /approved|applied/)
                assert.match(views[1]!, /prepared -> waiting -> approved -> applied/)
                assert.match(
                    state.answers.join(''),
                    /-export const answer = 42\n\+export const answer = 43/
                )
                assert.equal(
                    await readFile(join(state.workspace, 'answer.ts'), 'utf8'),
                    'export const answer = 43\n'
                )
            } finally {
                await rm(state.workspace, { recursive: true, force: true })
            }
        })
})

test('non-TTY patch denial leaves the following inspection line at the chat prompt', async () => {
    let step = 0
    const prompts: string[] = [],
        lines = ['Patch', '/run 1', '/exit']
    const state = await fixture(
        lines,
        async () =>
            step++ === 0
                ? {
                      type: 'tool_calls',
                      model: null,
                      toolCalls: [
                          {
                              id: 'patch',
                              name: 'propose_patch',
                              arguments: {
                                  path: 'answer.ts',
                                  edits: [{ oldText: '42', newText: '43' }],
                              },
                          },
                      ],
                  }
                : { type: 'final_answer', model: null, content: 'Denied.' },
        {
            createLineInput: () => ({
                readLine: async (prompt) => {
                    prompts.push(prompt)
                    return lines.shift() ?? null
                },
                close: () => undefined,
            }),
        }
    )
    try {
        await writeFile(join(state.workspace, 'answer.ts'), '42\n')
        assert.equal((await runCli(['--cwd', state.workspace], state.dependencies)).exitCode, 0)
        assert.deepEqual(prompts, ['yo> ', 'yo> ', 'yo> '])
        assert.match(state.output.at(-1)!, /Retained answer:\nDenied/)
        assert.match(state.output.at(-1)!, /waiting -> denied/)
        assert.equal(await readFile(join(state.workspace, 'answer.ts'), 'utf8'), '42\n')
        assert.doesNotMatch(state.output.join(''), /\u001b/)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('multi-turn inspection retains failed/budget evidence and fresh sessions start empty', async () => {
    const state = await fixture([], answer)
    const tasks = ['Long answer', 'Missing file', 'Transport error', 'Budget', 'Follow up']
    try {
        const execute = async (inspection: boolean) => {
            const requests: ModelRequest[] = [],
                output: string[] = [],
                answers: string[] = []
            const lines = inspection
                ? [
                      '/runs',
                      tasks[0]!,
                      '/run 1',
                      tasks[1]!,
                      '/run 2',
                      tasks[2]!,
                      '/run 3',
                      tasks[3]!,
                      '/run 4',
                      '/run 2',
                      '/run 999',
                      tasks[4]!,
                      '/runs',
                      '/exit',
                  ]
                : [...tasks, '/exit']
            const result = await runCli(['--cwd', state.workspace], {
                ...state.dependencies,
                createLineInput: () => ({
                    readLine: async () => lines.shift() ?? null,
                    close: () => undefined,
                }),
                writeOutput: (text) => output.push(text),
                writeAnswer: (text) => answers.push(text),
                transport: async (request) => {
                    requests.push(structuredClone(request))
                    const task = request.messages.filter((m) => m.role === 'user').at(-1)?.content
                    if (task === 'Transport error') throw new Error('private transport payload')
                    if (
                        task === 'Budget' ||
                        (task === 'Missing file' && request.messages.at(-1)?.role === 'user')
                    ) {
                        return {
                            type: 'tool_calls',
                            model: null,
                            toolCalls: [
                                {
                                    id: `read-${requests.length}`,
                                    name: 'read_file',
                                    arguments: { path: 'missing.ts' },
                                },
                            ],
                        }
                    }
                    return {
                        type: 'final_answer',
                        model: null,
                        content: task === 'Long answer' ? 'x'.repeat(17000) : `Done: ${task}`,
                    }
                },
            })
            return { result, requests, output, answers }
        }
        const control = await execute(false),
            inspected = await execute(true)
        assert.equal(inspected.result.exitCode, 0)
        assert.deepEqual(inspected.requests, control.requests)
        assert.deepEqual(inspected.result.session?.messages, control.result.session?.messages)
        assert.deepEqual(inspected.answers, control.answers)
        assert.match(inspected.output[0]!, /No runs yet/)
        const views = inspected.output.filter((s) => s.includes('Retained answer:'))
        assert.equal(views.length, 5)
        assert.match(views[0]!, /Answer preview truncated/)
        assert.match(views[1]!, /execution_error/)
        assert.match(views[2]!, /transport_error/)
        assert.match(views[2]!, /no final answer/)
        assert.match(views[3]!, /result: budget_exhausted/)
        assert.match(views[3]!, /step_budget_exhausted/)
        assert.equal(views[1], views[4])
        assert.doesNotMatch(inspected.output.join(''), /private transport payload|\u001b/)
        assert.match(inspected.output.at(-1)!, /#5 Follow up/)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})
