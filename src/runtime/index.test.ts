import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as runtime from './index.ts'
import type {
    ModelTransport,
    RunAgentOptions,
    RunEventObserver,
    RunEventSnapshot,
} from './index.ts'

const {
    appendTurnToConversation,
    canonicalizeWorkspaceRoot,
    createConversation,
    createConversationTurnResult,
    dispatchToolCall,
    listFiles,
    readFile,
    runAgent,
    searchCode,
} = runtime

const completeMetadata = {
    truncated: false,
    truncation: null,
} as const

test('exports only the approved read-only runtime capabilities', () => {
    assert.deepEqual(Object.keys(runtime).sort(), [
        'appendTurnToConversation',
        'canonicalizeWorkspaceRoot',
        'createConversation',
        'createConversationTurnResult',
        'dispatchToolCall',
        'isSensitivePath',
        'listFiles',
        'listFilesArgumentsSchema',
        'readFile',
        'readFileArgumentsSchema',
        'resolveWorkspacePath',
        'runAgent',
        'runConversationTurn',
        'searchCode',
        'searchCodeArgumentsSchema',
    ])
})

test('exports and runs the basic read-only filesystem flow', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-runtime-flow-'))
    const workspace = join(fixtureRoot, 'workspace')
    const sourceDirectory = join(workspace, 'src')

    try {
        await mkdir(sourceDirectory, { recursive: true })
        await writeFile(
            join(sourceDirectory, 'agent.ts'),
            "const task = 'inspect'\nexport const needle = task\n"
        )

        const workspaceRoot = await canonicalizeWorkspaceRoot(workspace)

        assert.deepEqual(await listFiles(workspaceRoot, { path: '.' }), {
            status: 'success',
            entries: ['src/'],
            metadata: completeMetadata,
        })
        assert.deepEqual(await searchCode(workspaceRoot, { query: 'needle', path: 'src' }), {
            status: 'success',
            matches: ['src/agent.ts:2:export const needle = task'],
            metadata: completeMetadata,
        })
        assert.deepEqual(
            await readFile(workspaceRoot, {
                path: 'src/agent.ts',
                startLine: 2,
                endLine: 2,
            }),
            {
                status: 'success',
                content: '2:export const needle = task',
                metadata: completeMetadata,
            }
        )
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
    }
})

test('exports the read-only tool dispatcher', () => {
    assert.equal(typeof dispatchToolCall, 'function')
})

test('exports the bounded read-only agent loop', () => {
    assert.equal(typeof runAgent, 'function')
})

test('exposes the optional event observer contract through the runtime barrel', async () => {
    const transport: ModelTransport = async () => ({
        type: 'final_answer',
        model: null,
        content: 'Done.',
    })
    const options = {
        task: 'Finish.',
        workspaceRoot: '/approved/workspace',
        budget: {
            maxSteps: 1,
            perToolTimeoutMs: 1_000,
        },
        model: null,
        transport,
    } satisfies RunAgentOptions

    const withoutObserver = await runAgent(options)
    const observed: RunEventSnapshot[] = []
    const onEvent: RunEventObserver = (event) => {
        observed.push(event)
    }
    const withObserver = await runAgent({ ...options, onEvent })

    assert.equal(withoutObserver.finalAnswer, 'Done.')
    assert.deepEqual(observed, withObserver.events)
})
