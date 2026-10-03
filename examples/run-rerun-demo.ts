import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { runCli } from '../src/cli-app.ts'
import { createNodeLineInput, type ChatSubmission } from '../src/line-input.ts'
import {
    runConversationTurn,
    type RunConversationTurnOptions,
    type RunConversationTurnResult,
} from '../src/runtime/conversation.ts'
import type { ModelRequest, ModelTransport } from '../src/runtime/run.ts'
import { PATCH_APPROVAL_PROMPT } from '../src/terminal-approval.ts'

const tty = process.argv.includes('--tty')
if (tty && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error('--tty requires an interactive terminal')

const workspace = await mkdtemp(join(tmpdir(), 'yo-rerun-demo-'))
const path = join(workspace, 'answer.ts')
const original = 'export const answer = 42\n'
const corrected = 'export const answer = 44\n// Keep this corrective marker: 🧩\n'
const changed = corrected.replace('44', '45')
const task = '  Read and patch answer.ts  '
const correction = 'Correction: keep the marker; use current answer.ts.'
const stream = new PassThrough(),
    terminal = new PassThrough()
terminal.resume()
const sourceReview = Promise.withResolvers<void>()
const rerunWaiting = Promise.withResolvers<void>()
const releaseRerun = Promise.withResolvers<void>()
const invocations: RunConversationTurnOptions[] = []
const results: RunConversationTurnResult[] = []
const requests: ModelRequest[][] = []
const submissions: ChatSubmission[] = []
const approvalReads: string[] = []
const previews: string[] = []
const output: string[] = []
const errors: string[] = []
let prompts = 0,
    approvals = 0,
    monotonicTime = 0
const say = (message: string) => process.stdout.write(`${message}\n`)
const send = (line: string) => {
    say(
        line
            .split('\n')
            .map((value) => JSON.stringify(value))
            .join('\n')
    )
    stream.write(`${line}\n`)
}

// This passive demo gate observes Return without reading or consuming the native buffer.
const waitForBufferedLine = async (signal: AbortSignal) => {
    const gate = Promise.withResolvers<void>()
    const onData = (chunk: Buffer | string) => {
        if (/[\r\n]/.test(chunk.toString())) gate.resolve()
    }
    const release = () => gate.resolve()
    process.stdin.on('data', onData)
    process.stdin.once('end', release)
    signal.addEventListener('abort', release, { once: true })
    try {
        say('[RERUN_READ_WAIT: enter /rerun  1 now; the line stays buffered]')
        if (signal.aborted) gate.resolve()
        await gate.promise
    } finally {
        process.stdin.off('data', onData)
        process.stdin.off('end', release)
        signal.removeEventListener('abort', release)
    }
}

const transport: ModelTransport = async (request, options) => {
    const turn = invocations.length
    const turnRequests = requests[turn - 1]!
    turnRequests.push(structuredClone(request))
    monotonicTime += 25
    const step = turnRequests.length
    if (turn === 2) return { type: 'final_answer', model: null, content: 'Correction retained.' }
    if (step === 1)
        return {
            type: 'tool_calls',
            model: null,
            toolCalls: [
                { id: `read-${turn}`, name: 'read_file', arguments: { path: 'answer.ts' } },
            ],
        }
    if (turn === 3) {
        assert.equal(step, 2)
        const signal = options?.signal
        assert.ok(signal)
        if (tty) await waitForBufferedLine(signal)
        else {
            say('[RERUN_READ_WAIT: current-file read completed; model response held]')
            rerunWaiting.resolve()
            await releaseRerun.promise
        }
        return {
            type: 'final_answer',
            model: null,
            content: 'Current answer is 44; correction retained.',
        }
    }
    if (step === 2)
        return {
            type: 'tool_calls',
            model: null,
            toolCalls: [
                {
                    id: `patch-${turn}`,
                    name: 'propose_patch',
                    arguments: {
                        path: 'answer.ts',
                        edits: [
                            {
                                oldText: turn === 1 ? '42' : '44',
                                newText: turn === 1 ? '43' : '45',
                            },
                        ],
                    },
                },
            ],
        }
    return {
        type: 'final_answer',
        model: null,
        content:
            turn === 4
                ? 'Fresh proposal denied; answer stays 44.'
                : 'Fresh consent applied 45; marker retained.',
    }
}

try {
    await writeFile(path, original)
    say(
        tty
            ? 'Local faux model; no OAuth/network. Follow this exact scenario; assertions run on /exit.\n1. Enter "  Read and patch answer.ts  "; Ctrl+C at SOURCE_REVIEW.\n2. /run 1, then "Correction: keep the marker; use current answer.ts."\n3. At yo> paste /rerun 1 and a second line " /rerun\t1 ".\n4. At RERUN_READ_WAIT enter /rerun  1; it releases the passive demo gate.\n5. After duplicates drain: /run 1, /run 3, /rerun 1.\n6. At FRESH_REVIEW_DENY enter /rerun 1 (denies, never queues).\n7. /run 1, /rerun 1; at FRESH_REVIEW_APPROVE enter yes.\n8. /runs, /run 1, /run 5, /exit. Temporary fixture is removed on exit.'
            : 'Deterministic faux interactive rerun demo; native readline, local fixture, no OAuth/network.'
    )
    const input = tty ? process.stdin : stream
    const listenerCounts = ['keypress', 'error'].map((event) => input.listenerCount(event))
    const native = createNodeLineInput({
        input,
        output: tty ? process.stdout : terminal,
        isInteractive: true,
    })
    const lines = new Map([
        [1, task],
        [2, '/run 1'],
        [3, correction],
        [4, '/rerun 1\n /rerun\t1 '],
        [7, '/run 1'],
        [8, '/run 3'],
        [9, '/rerun 1'],
        [10, '/run 1'],
        [11, '/rerun 1'],
        [12, '/runs'],
        [13, '/run 1'],
        [14, '/run 5'],
        [15, '/exit'],
    ])
    const running = runCli(['--cwd', workspace], {
        transport,
        observationClocks: {
            wallTime: () => Date.UTC(2026, 9, 3, 12),
            monotonicTime: () => monotonicTime,
        },
        runTurn: async (options) => {
            invocations.push(options)
            requests.push([])
            if (invocations.length === 2) {
                assert.equal(await readFile(path, 'utf8'), original)
                await writeFile(path, corrected)
                say('[CORRECTION: trusted temporary-fixture edit sets 44 and adds marker]')
            }
            const result = await runConversationTurn(options)
            results.push(structuredClone(result))
            return result
        },
        createLineInput: () => ({
            ...native,
            readChatSubmission: async (prompt, options) => {
                const pending = native.readChatSubmission!(prompt, options)
                prompts++
                if (!tty) {
                    process.stdout.write(prompt)
                    const line = lines.get(prompts)
                    if (line !== undefined) send(line)
                }
                const submission = await pending
                if (submission !== null) submissions.push(submission)
                return submission
            },
            readLine: async (prompt, options) => {
                assert.equal(prompt, PATCH_APPROVAL_PROMPT)
                const pending = native.readLine(prompt, options)
                approvals++
                const label = [
                    'SOURCE_REVIEW: Ctrl+C',
                    'FRESH_REVIEW_DENY: enter /rerun 1',
                    'FRESH_REVIEW_APPROVE: enter yes',
                ][approvals - 1]
                assert.ok(label)
                assert.equal(previews.length, approvals)
                assert.equal(await readFile(path, 'utf8'), approvals === 1 ? original : corrected)
                if (!tty) process.stdout.write(prompt)
                say(`[${label}]`)
                if (approvals === 1) sourceReview.resolve()
                else if (!tty) send(approvals === 2 ? '/rerun 1' : 'yes')
                const line = await pending
                if (line !== null) approvalReads.push(line)
                return line
            },
        }),
        writeOutput: (message) => {
            output.push(message)
            say(message)
        },
        writeStatus: (message) =>
            process.stdout.write(message.endsWith('\n') ? message : `${message}\n`),
        writeAnswer: (message) => {
            if (message.startsWith('Patch proposal:')) previews.push(message)
            process.stdout.write(message)
        },
        writeError: (message) => {
            errors.push(message)
            process.stderr.write(`${message}\n`)
        },
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: true,
    })
    if (!tty) {
        const reach = (gate: Promise<void>) =>
            Promise.race([
                gate,
                running.then(() => {
                    throw new Error('Demo gate not reached')
                }),
            ])
        await reach(sourceReview.promise)
        say('[Ctrl+C cancels source review; old proposal has no consent]')
        stream.write('\x03')
        await reach(rerunWaiting.promise)
        assert.equal(results.length, 2)
        assert.equal(invocations.length, 3)
        assert.equal(prompts, 4)
        send(' /rerun  1')
        say('[Two normalized duplicates retain arrival window 4 across settlement]')
        releaseRerun.resolve()
    }
    const result = await running
    assert.equal(result.exitCode, 0)
    assert.deepEqual(errors, [])
    assert.equal(await readFile(path, 'utf8'), changed)
    assert.deepEqual(
        invocations.map(({ task }) => task),
        [task, correction, task, task, task]
    )
    assert.deepEqual(
        requests.map((batch) => batch.length),
        [2, 1, 2, 3, 3]
    )
    assert.deepEqual(
        results.map(({ turn }) => turn.session.status),
        ['aborted', 'completed', 'completed', 'completed', 'completed']
    )
    assert.equal(results[0]!.turn.session.stopReason, 'aborted')
    for (const [index, invocation] of invocations.entries()) {
        assert.deepEqual(invocation.budget, { maxSteps: 10, perToolTimeoutMs: 5_000 })
        assert.ok(invocation.signal)
        if (index > 0) assert.equal(invocation.signal.aborted, false)
        if (index > 0)
            assert.deepEqual(requests[index]![0]!.messages, [
                ...results[index - 1]!.conversation.messages,
                { role: 'user', content: invocation.task },
            ])
        assert.deepEqual(results[index]!.conversation.messages, [
            ...invocation.conversation.messages,
            ...results[index]!.turn.messages,
        ])
    }
    assert.equal(new Set(invocations.map(({ signal }) => signal)).size, 5)
    assert.doesNotMatch(JSON.stringify(requests), /\/rerun|windowId|sourceId/)
    for (const index of [0, 2, 3, 4]) {
        const read = results[index]!.turn.messages.find(
            (message) => message.role === 'tool' && message.result.callId === `read-${index + 1}`
        )
        assert.ok(read?.role === 'tool')
        assert.equal(read.result.status, 'success')
        assert.equal(
            read.result.content,
            index === 0
                ? '1:export const answer = 42'
                : '1:export const answer = 44\n2:// Keep this corrective marker: 🧩'
        )
    }
    const expectedPreview = (before: number, after: number) =>
        `Patch proposal: answer.ts\n--- answer.ts\n+++ answer.ts\n-export const answer = ${before}\n+export const answer = ${after}\n\n`
    assert.deepEqual(previews, [
        expectedPreview(42, 43),
        expectedPreview(44, 45),
        expectedPreview(44, 45),
    ])
    assert.equal(approvals, 3)
    assert.deepEqual(approvalReads, ['/rerun 1', 'yes'])
    assert.deepEqual(
        results.flatMap(({ turn }) =>
            turn.session.events
                .filter((event) => event.type === 'patch_approval_resolved')
                .map((event) => event.decision)
        ),
        ['aborted', 'denied', 'approved']
    )
    assert.equal(
        results.flatMap(({ turn }) =>
            turn.session.events.filter((event) => event.type === 'patch_applied')
        ).length,
        1
    )
    const rerunLines = submissions.filter(({ line }) => line.trim().startsWith('/rerun'))
    assert.deepEqual(
        rerunLines.map(({ windowId }) => windowId),
        [4, 4, 4, 9, 11]
    )
    assert.equal(
        output.filter((message) => message === 'Rerun action already accepted as Run #3.').length,
        2
    )
    const sourceInspections = output.filter(
        (message) => message.startsWith('Run #1:') && message.includes('\nEvents:\n')
    )
    assert.equal(sourceInspections.length, 4)
    for (const inspection of sourceInspections) assert.equal(inspection, sourceInspections[0])
    for (const id of [3, 4, 5]) {
        assert.match(
            output.find((message) => message.startsWith(`Run #${id} result:`)) ?? '',
            /Rerun of #1.*Context: current conversation/s
        )
    }
    assert.match(
        output.find((message) => message.startsWith('Run #3:')) ?? '',
        /Rerun of #1.*Context: current conversation/s
    )
    assert.deepEqual(
        ['keypress', 'error'].map((event) => input.listenerCount(event)),
        listenerCounts
    )
    say(
        '[VERIFIED: exact source task/current transcript; changed-file reads; five fresh attempts; two suppressed duplicates; denial owns command input; new full-diff yes; immutable source inspections]'
    )
    process.exitCode = result.exitCode
} finally {
    stream.destroy()
    terminal.destroy()
    await rm(workspace, { recursive: true, force: true })
}
