import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../../src/cli-app.ts'
import type { ModelTransport } from '../../src/runtime/run.ts'

const workspace = await mkdtemp(join(tmpdir(), 'yo-observation-demo-'))
const lines = ['Read answer.ts', '/exit']
let requestCount = 0
let monotonicTime = 0
const transport: ModelTransport = async () => {
    monotonicTime += 25
    if (requestCount++ === 0) {
        return {
            type: 'tool_calls',
            model: null,
            toolCalls: [{ id: 'read-answer', name: 'read_file', arguments: { path: 'answer.ts' } }],
        }
    }
    return { type: 'final_answer', model: null, content: 'The answer is 42 in answer.ts:1.' }
}

try {
    await writeFile(join(workspace, 'answer.ts'), 'export const answer = 42\n')
    const result = await runCli(['--cwd', workspace], {
        transport,
        observationClocks: {
            wallTime: () => new Date(2026, 9, 2, 12, 0, 0).getTime(),
            monotonicTime: () => monotonicTime,
        },
        createLineInput: () => ({
            readLine: async () => lines.shift() ?? null,
            close: () => undefined,
        }),
        // Merge terminal channels only in this deterministic review demonstration.
        writeOutput: (message) => process.stdout.write(`${message}\n`),
        writeStatus: (message) => process.stdout.write(message),
        writeAnswer: (message) => process.stdout.write(message),
        writeError: (message) => process.stderr.write(`${message}\n`),
        clearStatusLine: () => undefined,
        moveStatusCursorToStart: () => undefined,
        isInteractive: false,
    })
    process.exitCode = result.exitCode
} finally {
    await rm(workspace, { recursive: true, force: true })
}
