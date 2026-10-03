import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { runCli } from '../src/cli-app.ts'
import { createNodeLineInput } from '../src/line-input.ts'
import { runConversationTurn } from '../src/runtime/conversation.ts'
import type { ModelTransport } from '../src/runtime/run.ts'
import { PATCH_APPROVAL_PROMPT } from '../src/terminal-approval.ts'

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}
const tty = process.argv.includes('--tty')
if (tty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('--tty requires an interactive terminal')
}
const workspace = await mkdtemp(join(tmpdir(), 'yo-cancellation-demo-'))
const source = join(workspace, 'answer.ts')
const original = 'export const answer = 42\n'
const changed = 'export const answer = 43\n'
const stream = new PassThrough(),
    terminal = new PassThrough()
terminal.resume()
const modelWaiting = deferred<void>(),
    releaseModel = deferred<void>()
const approvalWaiting = deferred<void>(),
    cancelledReview = deferred<void>()
const releaseReview = deferred<void>(),
    freshApproval = deferred<void>()
const freshPrompt = deferred<void>()
const output: string[] = [],
    statuses: string[] = [],
    answers: string[] = []
let monotonicTime = 0,
    approvals = 0,
    prompts = 0
const transport: ModelTransport = async (request, options) => {
    monotonicTime += 25
    const task = request.messages.filter((message) => message.role === 'user').at(-1)?.content
    if (request.messages.at(-1)?.role === 'user') {
        if (task === 'Read answer.ts') {
            return {
                type: 'tool_calls',
                model: null,
                toolCalls: [
                    { id: 'read-answer', name: 'read_file', arguments: { path: 'answer.ts' } },
                ],
            }
        }
        if (task === 'Patch answer.ts') {
            return {
                type: 'tool_calls',
                model: null,
                toolCalls: [
                    {
                        id: 'patch-answer',
                        name: 'propose_patch',
                        arguments: {
                            path: 'answer.ts',
                            edits: [{ oldText: '42', newText: '43' }],
                        },
                    },
                ],
            }
        }
    }
    if (task === 'Read answer.ts') {
        modelWaiting.resolve()
        process.stdout.write('[Read completed; model waits for Ctrl+C, then settles cleanup]\n')
        if (tty) {
            const signal = options?.signal
            assert.ok(signal)
            // Retain owned work after EOF so the scoped process SIGINT route can settle it.
            const keepAlive = setInterval(() => undefined, 1_000)
            try {
                if (!signal.aborted) {
                    await new Promise<void>((resolve) =>
                        signal.addEventListener('abort', () => resolve(), { once: true })
                    )
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 100))
            } finally {
                clearInterval(keepAlive)
            }
        } else await releaseModel.promise
        // The runtime must discard this response after observing cancellation.
        return { type: 'final_answer', model: null, content: 'Late answer must not appear.' }
    }
    const last = request.messages.at(-1)
    return {
        type: 'final_answer',
        model: null,
        content:
            last?.role === 'tool' && last.result.status === 'success'
                ? 'Fresh consent applied the patch; answer.ts now contains 43.'
                : 'No patch was applied.',
    }
}

try {
    await writeFile(source, original)
    process.stdout.write(
        tty
            ? 'Local faux model; no OAuth or network. Temporary fixture is removed on exit.\nType Read answer.ts, Ctrl+C at the model wait, /runs, /run 1.\nType Patch answer.ts, Ctrl+C at approval, /run 2.\nType Patch answer.ts again, give fresh y, /runs, /run 2, /exit.\n'
            : 'Deterministic faux interactive demo; native readline, local fixture, no OAuth or network.\n'
    )
    const native = createNodeLineInput({
        input: tty ? process.stdin : stream,
        output: tty ? process.stdout : terminal,
        isInteractive: true,
    })
    const lines = [
        '/runs',
        'Read answer.ts',
        '/runs',
        '/run 1',
        'Patch answer.ts',
        '/run 2',
        'Patch answer.ts',
        '/runs',
        '/run 1',
        '/run 2',
        '/exit',
    ]
    const send = (line: string) => {
        process.stdout.write(`${line}\n`)
        stream.write(`${line}\n`)
    }
    const running = runCli(['--cwd', workspace], {
        transport,
        observationClocks: {
            wallTime: () => Date.UTC(2026, 9, 2, 12, 0, 0),
            monotonicTime: () => monotonicTime,
        },
        runTurn: async (options) => {
            const result = await runConversationTurn(options)
            if (
                !tty &&
                options.task === 'Patch answer.ts' &&
                result.turn.session.status === 'aborted'
            ) {
                cancelledReview.resolve()
                await releaseReview.promise
            }
            return result
        },
        createLineInput: () =>
            tty
                ? native
                : {
                      ...native,
                      readLine: (prompt, options) => {
                          const result = native.readLine(prompt, options)
                          process.stdout.write(prompt)
                          assert.equal(prompt, PATCH_APPROVAL_PROMPT)
                          approvals += 1
                          process.stdout.write('[waiting for explicit input]\n')
                          const gate = approvals === 1 ? approvalWaiting : freshApproval
                          gate.resolve()
                          return result
                      },
                      readChatSubmission: (prompt, options) => {
                          const result = native.readChatSubmission!(prompt, options)
                          process.stdout.write(prompt)
                          prompts += 1
                          if (prompts === 6) freshPrompt.resolve()
                          send(lines.shift() ?? '/exit')
                          return result
                      },
                  },
        // Durable progress lines make the captured faux transcript easy to review.
        writeOutput: (message) => {
            output.push(message)
            process.stdout.write(`${message}\n`)
        },
        writeStatus: (message) => {
            statuses.push(message)
            process.stdout.write(message.endsWith('\n') ? message : `${message}\n`)
        },
        writeAnswer: (message) => {
            answers.push(message)
            process.stdout.write(message)
        },
        writeError: (message) => process.stderr.write(`${message}\n`),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: true,
    })
    if (!tty) {
        const reach = async (gate: Promise<void>) =>
            Promise.race([
                gate,
                running.then(() => {
                    throw new Error('Demo gate not reached')
                }),
            ])
        await reach(modelWaiting.promise)
        process.stdout.write('[Ctrl+C twice while model cleanup is held]\n')
        stream.write('\x03\x03')
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert.match(statuses.join(''), /cancellation requested/)
        assert.equal(prompts, 2)
        assert.equal(output.length, 1)
        monotonicTime += 100
        process.stdout.write('[Cancellation requested; only now release model cleanup]\n')
        releaseModel.resolve()
        await reach(approvalWaiting.promise)
        assert.equal(await readFile(source, 'utf8'), original)
        process.stdout.write('[Partial y, then Ctrl+C cancels approval]\n')
        stream.write('y\x03')
        await reach(cancelledReview.promise)
        process.stdout.write('[Late y during cancellation is discarded]\n')
        stream.write('y\n')
        assert.equal(await readFile(source, 'utf8'), original)
        assert.equal(prompts, 5)
        process.stdout.write('[Cancelled review settled; file remains 42]\n')
        releaseReview.resolve()
        await reach(freshPrompt.promise)
        await reach(freshApproval.promise)
        assert.equal(await readFile(source, 'utf8'), original)
        process.stdout.write('[A new proposal needs new consent]\n')
        send('y')
    }
    const result = await running
    assert.equal(result.exitCode, 0)
    if (!tty) {
        assert.equal(await readFile(source, 'utf8'), changed)
        assert.equal(result.session?.status, 'completed')
        assert.doesNotMatch(answers.join(''), /Late answer/)
        for (const id of [1, 2]) {
            const inspections = output.filter(
                (message) => message.startsWith(`Run #${id}:`) && message.includes('\nEvents:\n')
            )
            assert.equal(inspections.length, 2)
            assert.equal(inspections[0], inspections[1])
        }
        assert.equal(approvals, 2)
        process.stdout.write(
            '[Verified fresh consent changed 42 to 43; cancelled run inspection stays frozen]\n'
        )
    }
    process.exitCode = result.exitCode
} finally {
    stream.destroy()
    terminal.destroy()
    await rm(workspace, { recursive: true, force: true })
}
