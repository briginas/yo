import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runCli, type CliDependencies } from './cli-app.ts'
import { CHAT_PROMPT, type ChatSubmission } from './line-input.ts'
import { runConversationTurn, type RunConversationTurnResult } from './runtime/conversation.ts'
import type { PatchApprovalView } from './runtime/patch-contracts.ts'
import type { ModelRequest, ModelResponse, RunEvent, SessionMessage } from './runtime/run.ts'
import type { ToolCall } from './runtime/tools.ts'
import { PATCH_APPROVAL_PROMPT } from './terminal-approval.ts'

type InputArrival =
    { type: 'chat'; submission: ChatSubmission } | { type: 'approval'; line: string }
const chat = (line: string, windowId: number): InputArrival => ({
    type: 'chat',
    submission: { line, windowId },
})
const approval = (line: string): InputArrival => ({ type: 'approval', line })
const finalAnswer = (content: string): ModelResponse => ({
    type: 'final_answer',
    model: null,
    content,
})
const toolCall = (call: ToolCall): ModelResponse => ({
    type: 'tool_calls',
    model: null,
    toolCalls: [call],
})
const toolResults = (messages: readonly SessionMessage[]) =>
    messages.filter((message) => message.role === 'tool').map((message) => message.result)
const hash = (content: string): string => createHash('sha256').update(content).digest('hex')

const fixture = async ({
    source,
    arrivals,
    isInteractive = false,
    respond,
    afterSource,
}: {
    source: string
    arrivals: readonly InputArrival[]
    isInteractive?: boolean
    respond: (turn: number, step: number, request: ModelRequest) => ModelResponse
    afterSource?: (path: string) => Promise<void>
}) => {
    const workspace = await mkdtemp(join(tmpdir(), 'yo-rerun-workspace-'))
    const path = join(workspace, 'settings.ts')
    await writeFile(path, source)
    const pending = [...arrivals]
    const requests: ModelRequest[][] = []
    const results: RunConversationTurnResult[] = []
    const proposals: PatchApprovalView[] = []
    const previews: string[] = []
    const approvalReads: { preview: string; bytes: string; response: string }[] = []
    const chatReads: ChatSubmission[] = []
    const answers: string[] = [],
        output: string[] = [],
        errors: string[] = []
    let closeCount = 0
    const dependencies: CliDependencies = {
        transport: async (request) => {
            const turn = requests.length
            requests[turn - 1]!.push(structuredClone(request))
            return respond(turn, requests[turn - 1]!.length, request)
        },
        runTurn: async (options) => {
            requests.push([])
            assert.ok(options.patchApprover)
            const terminalApprover = options.patchApprover
            const result = await runConversationTurn({
                ...options,
                patchApprover: async (view, approvalOptions) => {
                    proposals.push(structuredClone(view))
                    return terminalApprover(view, approvalOptions)
                },
            })
            results.push(structuredClone(result))
            if (results.length === 1) await afterSource?.(path)
            return result
        },
        createLineInput: () => ({
            readChatSubmission: async (prompt) => {
                assert.equal(prompt, CHAT_PROMPT)
                const arrival = pending.shift()
                if (arrival === undefined) return null
                assert.equal(arrival.type, 'chat')
                if (arrival.type !== 'chat') throw new Error('Approval arrived at chat read')
                chatReads.push(arrival.submission)
                return arrival.submission
            },
            readLine: async (prompt) => {
                assert.equal(prompt, PATCH_APPROVAL_PROMPT)
                const arrival = pending.shift()
                assert.equal(arrival?.type, 'approval')
                if (arrival?.type !== 'approval') throw new Error('Chat arrived at approval read')
                approvalReads.push({
                    preview: previews.at(-1)!,
                    bytes: await readFile(path, 'utf8'),
                    response: arrival.line,
                })
                return arrival.line
            },
            close: () => {
                closeCount++
            },
        }),
        subscribeProcessInterrupt: () => () => undefined,
        writeOutput: (text) => output.push(text),
        writeError: (text) => errors.push(text),
        writeAnswer: (text) => {
            answers.push(text)
            if (text.startsWith('Patch proposal:')) previews.push(text)
        },
        writeStatus: () => undefined,
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive,
        observationClocks: { wallTime: () => 100, monotonicTime: () => 100 },
    }
    return {
        path,
        workspace,
        requests,
        results,
        proposals,
        previews,
        approvalReads,
        chatReads,
        answers,
        output,
        errors,
        start: () => runCli(['--cwd', workspace], dependencies),
        verifyInput: () => {
            assert.deepEqual(pending, [])
            assert.equal(closeCount, 1)
            assert.deepEqual(errors, [])
        },
        cleanup: () => rm(workspace, { recursive: true, force: true }),
    }
}

test('rerun read executes against externally changed bytes while retaining the historical result once', async () => {
    const source = 'export const version = 1\n// Original observation\n'
    const current = 'export const version = 3\n// Changed outside yo: 🧩\n'
    const state = await fixture({
        source,
        arrivals: [chat('Read settings.ts', 41), chat('/rerun 1', 42), chat('/exit', 43)],
        respond: (turn, step) =>
            step === 1
                ? toolCall({
                      id: `read-${turn}`,
                      name: 'read_file',
                      arguments: { path: 'settings.ts' },
                  })
                : finalAnswer(`Read attempt ${turn}`),
        afterSource: (path) => writeFile(path, current),
    })
    try {
        assert.equal((await state.start()).exitCode, 0)
        assert.equal(state.results.length, 2)
        const oldResult = toolResults(state.results[0]!.turn.messages)[0]!
        const newResult = toolResults(state.results[1]!.turn.messages)[0]!
        assert.equal(oldResult.status, 'success')
        assert.equal(oldResult.content, '1:export const version = 1\n2:// Original observation')
        assert.equal(newResult.status, 'success')
        assert.equal(newResult.content, '1:export const version = 3\n2:// Changed outside yo: 🧩')
        assert.deepEqual(state.requests[1]![0]!.messages, [
            ...state.results[0]!.conversation.messages,
            { role: 'user', content: 'Read settings.ts' },
        ])
        assert.deepEqual(toolResults(state.requests[1]![1]!.messages), [oldResult, newResult])
        assert.deepEqual(toolResults(state.results[1]!.conversation.messages), [
            oldResult,
            newResult,
        ])
        assert.equal(await readFile(state.path, 'utf8'), current)
        assert.deepEqual(state.proposals, [])
        assert.deepEqual(state.approvalReads, [])
        state.verifyInput()
    } finally {
        await state.cleanup()
    }
})

const source =
    'export const version = 1\nexport const feature = false\nexport const note = "source"\n'
const applied = source.replace('version = 1', 'version = 2')
const current = `${applied}// Changed outside yo\n`
const next = current.replace('feature = false', 'feature = true').replace('"source"', '"rerun"')
const sourceDiff =
    '--- settings.ts\n+++ settings.ts\n-export const version = 1\n+export const version = 2\n'
const rerunDiff =
    '--- settings.ts\n+++ settings.ts\n-export const feature = false\n-export const note = "source"\n+export const feature = true\n+export const note = "rerun"\n'
const propose = (turn: number, useSourceEdit = turn === 1): ModelResponse =>
    toolCall({
        id: `patch-${turn}`,
        name: 'propose_patch',
        arguments: {
            path: 'settings.ts',
            edits: useSourceEdit
                ? [{ oldText: 'version = 1', newText: 'version = 2' }]
                : [
                      { oldText: 'feature = false', newText: 'feature = true' },
                      { oldText: '"source"', newText: '"rerun"' },
                  ],
        },
    })
const patchEvents = (events: readonly RunEvent[]) =>
    events.filter(
        (event) =>
            event.type === 'patch_prepared' ||
            event.type === 'patch_approval_requested' ||
            event.type === 'patch_approval_resolved' ||
            event.type === 'patch_applied'
    )

test('applied source patch stays applied and rerun requires its own complete current-base consent', async (context) => {
    for (const response of ['yes', 'N']) {
        await context.test(response === 'yes' ? 'fresh approval' : 'fresh denial', async () => {
            const state = await fixture({
                source,
                arrivals: [
                    chat('Update settings.ts', 51),
                    approval('y'),
                    chat('/rerun 1', 52),
                    approval(response),
                    chat('/exit', 53),
                ],
                isInteractive: true,
                respond: (turn, step) =>
                    step === 1 ? propose(turn) : finalAnswer(`Patch attempt ${turn}`),
                afterSource: async (path) => {
                    assert.equal(await readFile(path, 'utf8'), applied)
                    await writeFile(path, current)
                },
            })
            try {
                assert.equal((await state.start()).exitCode, 0)
                assert.equal(state.results.length, 2)
                assert.deepEqual(
                    state.requests.map((requests) => requests.length),
                    [2, 2]
                )
                assert.equal(state.proposals.length, 2)
                assert.deepEqual(state.requests[1]![0]!.messages, [
                    ...state.results[0]!.conversation.messages,
                    { role: 'user', content: 'Update settings.ts' },
                ])
                const [oldProposal, newProposal] = state.proposals
                assert.notEqual(oldProposal!.id, newProposal!.id)
                assert.ok(
                    state.proposals.every(({ id }) => !JSON.stringify(state.requests).includes(id))
                )
                assert.deepEqual(
                    state.proposals.map(({ baseHash, nextHash, diff }) => ({
                        baseHash,
                        nextHash,
                        diff,
                    })),
                    [
                        { baseHash: hash(source), nextHash: hash(applied), diff: sourceDiff },
                        { baseHash: hash(current), nextHash: hash(next), diff: rerunDiff },
                    ]
                )
                assert.deepEqual(
                    state.previews,
                    [sourceDiff, rerunDiff].map((diff) => `Patch proposal: settings.ts\n${diff}\n`)
                )
                assert.deepEqual(state.approvalReads, [
                    { preview: state.previews[0], bytes: source, response: 'y' },
                    { preview: state.previews[1], bytes: current, response },
                ])
                for (const [index, result] of state.results.entries()) {
                    const proposal = state.proposals[index]!
                    const approved = index === 0 || response === 'yes'
                    const events = patchEvents(result.turn.session.events)
                    assert.deepEqual(
                        events.map(({ type }) => type),
                        [
                            'patch_prepared',
                            'patch_approval_requested',
                            'patch_approval_resolved',
                            ...(approved ? ['patch_applied'] : []),
                        ]
                    )
                    assert.ok(
                        events.every(
                            (event) =>
                                event.callId === `patch-${index + 1}` &&
                                event.metadata.proposalId === proposal.id
                        )
                    )
                    const resolved = events.find(
                        (event) => event.type === 'patch_approval_resolved'
                    )!
                    assert.equal(resolved.decision, approved ? 'approved' : 'denied')
                    assert.equal(
                        toolResults(result.turn.messages)[0]!.status,
                        approved ? 'success' : 'denied'
                    )
                }
                assert.deepEqual(toolResults(state.requests[1]![1]!.messages), [
                    ...toolResults(state.results[0]!.turn.messages),
                    ...toolResults(state.results[1]!.turn.messages),
                ])
                assert.deepEqual(
                    state.results[1]!.conversation.messages.filter(
                        (message) => message.role === 'user'
                    ),
                    [
                        { role: 'user', content: 'Update settings.ts' },
                        { role: 'user', content: 'Update settings.ts' },
                    ]
                )
                assert.equal(
                    await readFile(state.path, 'utf8'),
                    response === 'yes' ? next : current
                )
                assert.deepEqual(await readdir(state.workspace), ['settings.ts'])
                state.verifyInput()
            } finally {
                await state.cleanup()
            }
        })
    }
})

test('non-TTY source and rerun patches are denied without consuming later chat input', async () => {
    const state = await fixture({
        source,
        arrivals: [
            chat('Update settings.ts', 61),
            chat('/rerun 1', 62),
            chat('Next task', 63),
            chat('/exit', 64),
        ],
        respond: (turn, step) =>
            turn < 3 && step === 1 ? propose(turn, true) : finalAnswer(`Answer ${turn}`),
    })
    try {
        assert.equal((await state.start()).exitCode, 0)
        assert.equal(state.results.length, 3)
        assert.deepEqual(
            state.requests.map((requests) => requests.length),
            [2, 2, 1]
        )
        assert.deepEqual(state.approvalReads, [])
        assert.equal(state.proposals.length, 2)
        assert.notEqual(state.proposals[0]!.id, state.proposals[1]!.id)
        assert.deepEqual(
            state.previews,
            Array(2).fill(`Patch proposal: settings.ts\n${sourceDiff}\n${PATCH_APPROVAL_PROMPT}\n`)
        )
        for (const result of state.results.slice(0, 2)) {
            assert.equal(toolResults(result.turn.messages)[0]!.status, 'denied')
            assert.deepEqual(
                patchEvents(result.turn.session.events).map(({ type }) => type),
                ['patch_prepared', 'patch_approval_requested', 'patch_approval_resolved']
            )
            assert.equal(result.turn.session.status, 'completed')
        }
        assert.deepEqual(
            state.chatReads.map(({ line }) => line),
            ['Update settings.ts', '/rerun 1', 'Next task', '/exit']
        )
        assert.deepEqual(
            state.results[2]!.conversation.messages.filter((message) => message.role === 'user'),
            [
                { role: 'user', content: 'Update settings.ts' },
                { role: 'user', content: 'Update settings.ts' },
                { role: 'user', content: 'Next task' },
            ]
        )
        assert.equal(await readFile(state.path, 'utf8'), source)
        state.verifyInput()
    } finally {
        await state.cleanup()
    }
})
