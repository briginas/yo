import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../../src/cli-app.ts'
import { PATCH_APPROVAL_PROMPT } from '../../src/terminal-approval.ts'
import type { ModelTransport } from '../../src/runtime/run.ts'

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}
const modelWaiting = deferred<void>(),
    releaseModel = deferred<void>()
const approvalWaiting = deferred<void>(),
    releaseApproval = deferred<string>()
const workspace = await mkdtemp(join(tmpdir(), 'yo-observation-demo-'))
const lines = [
    '/runs',
    'Read answer.ts',
    '/run 1',
    'Show failure',
    '/run 2',
    'Patch answer.ts',
    '/run 3',
    'Continue chat',
    '/runs',
    '/exit',
]
let monotonicTime = 0
const transport: ModelTransport = async (request) => {
    monotonicTime += 25
    const task = request.messages.filter((message) => message.role === 'user').at(-1)?.content
    if (task === 'Show failure') throw new Error('private demo transport details')
    if (task === 'Read answer.ts' && request.messages.at(-1)?.role === 'user') {
        modelWaiting.resolve()
        await releaseModel.promise
        return {
            type: 'tool_calls',
            model: null,
            toolCalls: [{ id: 'read-answer', name: 'read_file', arguments: { path: 'answer.ts' } }],
        }
    }
    if (task === 'Patch answer.ts' && request.messages.at(-1)?.role === 'user') {
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
    return {
        type: 'final_answer',
        model: null,
        content:
            task === 'Read answer.ts'
                ? 'The answer is 42 in answer.ts:1.'
                : task === 'Patch answer.ts'
                  ? 'Approved patch applied: answer.ts now contains 43.'
                  : 'Chat continues after local inspection.',
    }
}

try {
    await writeFile(join(workspace, 'answer.ts'), 'export const answer = 42\n')
    const run = runCli(['--cwd', workspace], {
        transport,
        observationClocks: {
            wallTime: () => new Date(2026, 9, 2, 12, 0, 0).getTime(),
            monotonicTime: () => monotonicTime,
        },
        createLineInput: () => ({
            readLine: async (prompt) => {
                if (prompt === PATCH_APPROVAL_PROMPT) {
                    process.stdout.write(`${prompt}[waiting for explicit input]\n`)
                    approvalWaiting.resolve()
                    return releaseApproval.promise
                }
                const line = lines.shift() ?? null
                process.stdout.write(`${prompt}${line ?? '[EOF]'}\n`)
                return line
            },
            close: () => undefined,
        }),
        // This faux interactive demo merges channels and makes progress lines durable.
        // It exercises CLI composition, not a physical terminal emulator.
        writeOutput: (message) => process.stdout.write(`${message}\n`),
        writeStatus: (message) =>
            process.stdout.write(message.endsWith('\n') ? message : `${message}\n`),
        writeAnswer: (message) => process.stdout.write(message),
        writeError: (message) => process.stderr.write(`${message}\n`),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: true,
    })
    await Promise.race([
        modelWaiting.promise,
        run.then(() => {
            throw new Error('Model gate not reached')
        }),
    ])
    process.stdout.write('[Demo releases the delayed model response]\n')
    monotonicTime += 100
    releaseModel.resolve()
    await Promise.race([
        approvalWaiting.promise,
        run.then(() => {
            throw new Error('Approval gate not reached')
        }),
    ])
    assert.equal(await readFile(join(workspace, 'answer.ts'), 'utf8'), 'export const answer = 42\n')
    process.stdout.write('y\n')
    releaseApproval.resolve('y')
    const result = await run
    assert.equal(result.exitCode, 0)
    assert.equal(await readFile(join(workspace, 'answer.ts'), 'utf8'), 'export const answer = 43\n')
    process.exitCode = result.exitCode
} finally {
    await rm(workspace, { recursive: true, force: true })
}
