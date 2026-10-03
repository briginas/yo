import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runCli, type CliDependencies } from './cli-app.ts'
import type { ChatSubmission } from './line-input.ts'
import { runConversationTurn } from './runtime/conversation.ts'
import type { ModelRequest } from './runtime/run.ts'

const submission = (line: string, windowId = 1): ChatSubmission => ({ line, windowId })
const fixture = async (
    submissions: readonly ChatSubmission[],
    overrides: Partial<CliDependencies> = {}
) => {
    const workspace = await mkdtemp(join(tmpdir(), 'yo-rerun-routing-'))
    const pending = [...submissions]
    const requests: ModelRequest[] = []
    const tasks: string[] = []
    const output: string[] = []
    const statuses: string[] = []
    const errors: string[] = []
    const dependencies: CliDependencies = {
        transport: async (request) => {
            requests.push(structuredClone(request))
            return { type: 'final_answer', model: null, content: 'Done.' }
        },
        runTurn: async (options) => {
            tasks.push(options.task)
            return runConversationTurn(options)
        },
        createLineInput: () => ({
            readLine: async () => {
                throw new Error('Unexpected approval input')
            },
            readChatSubmission: async () => pending.shift() ?? null,
            close: () => undefined,
        }),
        writeOutput: (text) => output.push(text),
        writeError: (text) => errors.push(text),
        writeAnswer: () => undefined,
        writeStatus: (text) => statuses.push(text),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: false,
        observationClocks: { wallTime: () => 100, monotonicTime: () => 100 },
        ...overrides,
    }
    return { workspace, requests, tasks, output, statuses, errors, dependencies }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const headers = (state: Fixture): string[] =>
    state.statuses.filter((text) => text.startsWith('Run #'))
const userTasks = (request: ModelRequest | undefined): string[] =>
    request?.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.content) ?? []

test('malformed reserved rerun commands remain local and consume no run or transcript', async (context) => {
    for (const line of [
        '/rerun',
        '/rerun 0',
        '/rerun -1',
        '/rerun 01',
        '/rerun 1.5',
        '/rerun 1e2',
        '/rerun 9007199254740992',
        '/rerun 1 extra',
        ' \t/rerun\tBearer-private-command\t ',
    ]) {
        await context.test(JSON.stringify(line), async () => {
            const state = await fixture([submission(line), submission('Next')])
            try {
                const result = await runCli(['--cwd', state.workspace], state.dependencies)
                assert.equal(result.exitCode, 0)
                assert.deepEqual(state.tasks, ['Next'])
                assert.deepEqual(userTasks(state.requests[0]), ['Next'])
                assert.equal(headers(state).length, 1)
                assert.match(headers(state)[0]!, /^Run #1: Next/)
                assert.equal(state.output[0], 'Usage: /rerun N (positive run number).')
                assert.doesNotMatch(state.output.join(''), /Bearer-private-command/)
                assert.deepEqual(state.errors, [])
            } finally {
                await rm(state.workspace, { recursive: true, force: true })
            }
        })
    }
})

test('rerun lookalikes keep ordinary task text and exact whitespace', async () => {
    const lines = ['/rerunner', '/RERUN 1', '  Ordinary 🧩  ', ' /exit ']
    const state = await fixture(lines.map((line) => submission(line)))
    try {
        assert.equal((await runCli(['--cwd', state.workspace], state.dependencies)).exitCode, 0)
        assert.deepEqual(state.tasks, lines)
        assert.deepEqual(userTasks(state.requests.at(-1)), lines)
        assert.equal(headers(state).length, 4)
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('unknown source is local before and after ordinary settlement', async () => {
    const state = await fixture([
        submission('/rerun 1'),
        submission('First'),
        submission('/rerun 99'),
        submission('Second'),
    ])
    try {
        const result = await runCli(['--cwd', state.workspace], state.dependencies)
        assert.equal(result.exitCode, 0)
        assert.deepEqual(state.tasks, ['First', 'Second'])
        assert.deepEqual(userTasks(state.requests.at(-1)), state.tasks)
        assert.equal(headers(state).length, 2)
        assert.match(headers(state)[1]!, /^Run #2: Second/)
        assert.match(state.output[0]!, /^Run #1 is unavailable for rerun\.$/)
        assert.ok(state.output.includes('Run #99 is unavailable for rerun.'))
        assert.deepEqual(state.errors, [])
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('catalog rejects source settlement that observation cannot authorize', async (context) => {
    for (const outcome of [
        { status: 'running', stopReason: null },
        { status: 'completed', stopReason: 'transport_error' },
    ] as const) {
        await context.test(`${outcome.status}/${outcome.stopReason}`, async () => {
            let turns = 0
            const state = await fixture(
                [submission('First'), submission('/rerun 1'), submission('Second')],
                {
                    runTurn: async (options) => {
                        turns++
                        const result = await runConversationTurn(options)
                        return turns === 1
                            ? {
                                  ...result,
                                  turn: {
                                      ...result.turn,
                                      session: { ...result.turn.session, ...outcome },
                                  },
                              }
                            : result
                    },
                }
            )
            try {
                assert.equal(
                    (await runCli(['--cwd', state.workspace], state.dependencies)).exitCode,
                    0
                )
                assert.equal(turns, 2)
                assert.equal(state.requests.length, 2)
                assert.deepEqual(userTasks(state.requests.at(-1)), ['First', 'Second'])
                assert.equal(headers(state).length, 2)
                assert.match(headers(state)[1]!, /^Run #2: Second/)
                assert.ok(state.output.includes('Run #1 is not settled.'))
            } finally {
                await rm(state.workspace, { recursive: true, force: true })
            }
        })
    }
})

test('equivalent commands in one window retain their accepted receipt after settlement', async () => {
    const task = '  Exact source 🧩  '
    const state = await fixture([
        submission(task, 0),
        submission(' \t/rerun\t1  ', 0),
        submission('/rerun 1', 0),
        submission('/rerun 1', 2),
        submission('Next', 3),
        submission('/run 1', 4),
    ])
    try {
        assert.equal((await runCli(['--cwd', state.workspace], state.dependencies)).exitCode, 0)
        assert.deepEqual(state.tasks, [task, task, task, 'Next'])
        assert.deepEqual(userTasks(state.requests.at(-1)), state.tasks)
        assert.equal(headers(state).length, 4)
        assert.match(headers(state)[1]!, /^Run #2:/)
        assert.match(headers(state)[1]!, /Rerun of #1/)
        assert.match(headers(state)[1]!, /Context: current conversation/)
        assert.match(headers(state)[2]!, /^Run #3:/)
        assert.match(headers(state)[3]!, /^Run #4: Next/)
        assert.ok(state.output.includes('Rerun action already accepted as Run #2.'))
        assert.match(state.output.at(-1)!, /^Run #1:/)
        assert.doesNotMatch(state.output.at(-1)!, /Rerun of/)
        assert.deepEqual(state.errors, [])
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('legacy input keeps ordinary chat and inspection while rerun is rejected locally', async () => {
    const lines = ['First', '/rerun 1', '/runs', '/run 1', '/rerun 0', 'Second', '/exit']
    const state = await fixture([], {
        createLineInput: () => ({
            readLine: async () => lines.shift() ?? null,
            close: () => undefined,
        }),
    })
    try {
        assert.equal((await runCli(['--cwd', state.workspace], state.dependencies)).exitCode, 0)
        assert.deepEqual(state.tasks, ['First', 'Second'])
        assert.deepEqual(userTasks(state.requests.at(-1)), state.tasks)
        assert.equal(headers(state).length, 2)
        assert.match(headers(state)[1]!, /^Run #2:/)
        assert.ok(state.output.includes('Rerun requires input arrival identity support.'))
        assert.ok(state.output.some((text) => text.includes('Retained answer:')))
        assert.ok(state.output.includes('Usage: /rerun N (positive run number).'))
        assert.deepEqual(state.errors, [])
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})

test('invalid arrival identities do not allocate an attempt or consume a valid receipt', async (context) => {
    for (const windowId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
        await context.test(String(windowId), async () => {
            const state = await fixture([
                submission('First'),
                submission('/rerun 1', windowId),
                submission('/rerun 1', 2),
            ])
            try {
                assert.equal(
                    (await runCli(['--cwd', state.workspace], state.dependencies)).exitCode,
                    0
                )
                assert.deepEqual(state.tasks, ['First', 'First'])
                assert.equal(headers(state).length, 2)
                assert.match(headers(state)[1]!, /^Run #2:/)
                assert.ok(state.output.includes('Rerun requires a valid input arrival identity.'))
            } finally {
                await rm(state.workspace, { recursive: true, force: true })
            }
        })
    }
})

test('rerun diagnostics survive output and diagnostic writer failures without fallthrough', async (context) => {
    for (const line of ['/rerun Bearer-private-command', '/rerun 99', '/rerun 1']) {
        await context.test(line, async () => {
            let failures = 0
            const state = await fixture([
                submission('First', 1),
                submission('/rerun 1', 1),
                submission(line, 1),
                submission('Next', 2),
            ])
            state.dependencies.writeOutput = (text) => {
                if (/^(Usage:|Run #99 is unavailable|Rerun action already)/.test(text)) {
                    failures++
                    throw new Error('Bearer private diagnostic payload')
                }
                state.output.push(text)
            }
            state.dependencies.writeError = () => {
                throw new Error('private diagnostic writer failure')
            }
            try {
                assert.equal(
                    (await runCli(['--cwd', state.workspace], state.dependencies)).exitCode,
                    0
                )
                assert.equal(failures, 1)
                assert.deepEqual(state.tasks, ['First', 'First', 'Next'])
                assert.deepEqual(userTasks(state.requests.at(-1)), state.tasks)
                assert.equal(headers(state).length, 3)
                assert.match(headers(state)[2]!, /^Run #3: Next/)
                assert.doesNotMatch(state.output.join(''), /private|Bearer/)
            } finally {
                await rm(state.workspace, { recursive: true, force: true })
            }
        })
    }
})

test('rerun uses full source text while preview and local diagnostics stay safe', async () => {
    const secret = 'sk-' + 'a'.repeat(48)
    const task = ` \t${secret} ${'🧩'.repeat(180)}\u001b[2J end \t `
    const state = await fixture([
        submission(task),
        submission('/rerun 1'),
        submission('/rerun 1'),
        submission('/runs'),
        submission('/run 2'),
    ])
    try {
        assert.equal((await runCli(['--cwd', state.workspace], state.dependencies)).exitCode, 0)
        assert.deepEqual(state.tasks, [task, task])
        assert.deepEqual(userTasks(state.requests.at(-1)), [task, task])
        assert.equal(headers(state).length, 2)
        const visible = [...state.output, ...state.statuses, ...state.errors].join('')
        assert.ok(!visible.includes(secret))
        assert.ok(!visible.includes('🧩'.repeat(180)))
        assert.doesNotMatch(visible, /\u001b/)
        assert.match(visible, /Rerun of #1/)
        assert.ok(state.output.includes('Rerun action already accepted as Run #2.'))
    } finally {
        await rm(state.workspace, { recursive: true, force: true })
    }
})
