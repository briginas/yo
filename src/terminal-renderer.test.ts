import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    createTerminalRenderer,
    type TerminalStatus,
    type TerminalTextWriter,
} from './terminal-renderer.ts'
import type { RunEventSnapshot, RunEventObserver } from './runtime/run.ts'

const completeMetadata = {
    truncated: false,
    truncation: null,
} as const

const createRendererFixture = (isInteractive: boolean) => {
    const answers: string[] = []
    const statuses: TerminalStatus[] = []
    const errors: string[] = []
    const renderer = createTerminalRenderer({
        writeAnswer: (message) => answers.push(message),
        writeStatus: (status) => statuses.push(status),
        writeError: (message) => errors.push(message),
        isInteractive,
    })

    return {
        answers,
        statuses,
        errors,
        renderer,
    }
}

test('exposes separate answer, status, and error channels with injected terminal capability', () => {
    for (const isInteractive of [false, true]) {
        const { answers, statuses, errors, renderer } = createRendererFixture(isInteractive)
        const onEvent: RunEventObserver = renderer.onEvent
        const writeAnswer: TerminalTextWriter = renderer.writeAnswer
        const writeError: TerminalTextWriter = renderer.writeError

        writeAnswer('final answer')
        writeError('sanitized error')
        onEvent({
            type: 'model_requested',
            step: 1,
            metadata: {
                model: null,
                visibleTools: ['list_files', 'search_code', 'read_file'],
            },
        })

        assert.equal(renderer.isInteractive, isInteractive)
        assert.deepEqual(answers, ['final answer'])
        assert.deepEqual(errors, ['sanitized error'])
        assert.deepEqual(statuses, [
            {
                type: 'model_waiting',
                step: 1,
                active: true,
            },
        ])
    }
})

test('maps model and turn lifecycle events to renderer states', () => {
    const { renderer, statuses } = createRendererFixture(false)
    const events: RunEventSnapshot[] = [
        {
            type: 'run_started',
            task: 'Inspect the workspace.',
            workspaceRoot: '/approved/workspace',
            budget: {
                maxSteps: 2,
                perToolTimeoutMs: 1_000,
            },
        },
        {
            type: 'model_requested',
            step: 1,
            metadata: {
                model: null,
                visibleTools: ['list_files', 'search_code', 'read_file'],
            },
        },
        {
            type: 'model_responded',
            step: 1,
            metadata: {
                model: null,
                toolCallCount: 0,
                hasFinalAnswer: true,
            },
        },
        {
            type: 'final_answer',
            answer: 'Done.',
        },
        {
            type: 'run_finished',
            status: 'completed',
            reason: 'final_answer',
        },
    ]

    for (const event of events) {
        renderer.onEvent(event)
    }

    assert.deepEqual(statuses, [
        {
            type: 'model_waiting',
            step: 1,
            active: true,
        },
        {
            type: 'model_waiting',
            step: 1,
            active: false,
        },
        {
            type: 'turn_finished',
            status: 'completed',
            reason: 'final_answer',
        },
    ])
})

test('starts tool running only after an allow decision and maps successful completion', () => {
    const { renderer, statuses } = createRendererFixture(false)

    renderer.onEvent({
        type: 'tool_requested',
        step: 2,
        call: {
            id: 'call-1',
            name: 'read_file',
            arguments: {
                path: 'src/cli.ts',
            },
        },
    })
    assert.deepEqual(statuses, [])

    renderer.onEvent({
        type: 'tool_authorized',
        step: 2,
        callId: 'call-1',
        decision: {
            decision: 'allow',
        },
    })
    renderer.onEvent({
        type: 'tool_completed',
        step: 2,
        result: {
            status: 'success',
            callId: 'call-1',
            content: 'file contents',
            metadata: completeMetadata,
        },
    })

    assert.deepEqual(statuses, [
        {
            type: 'tool_running',
            step: 2,
            callId: 'call-1',
            toolName: 'read_file',
        },
        {
            type: 'tool_completed',
            step: 2,
            callId: 'call-1',
            toolName: 'read_file',
        },
    ])
})

test('does not show denied tools as running', () => {
    const { renderer, statuses } = createRendererFixture(false)

    renderer.onEvent({
        type: 'tool_requested',
        step: 1,
        call: {
            id: 'call-denied',
            name: 'read_file',
            arguments: {
                path: '../outside.txt',
            },
        },
    })
    renderer.onEvent({
        type: 'tool_authorized',
        step: 1,
        callId: 'call-denied',
        decision: {
            decision: 'deny',
            reason: 'outside_workspace',
        },
    })
    renderer.onEvent({
        type: 'tool_completed',
        step: 1,
        result: {
            status: 'denied',
            callId: 'call-denied',
            content: 'denied',
            metadata: completeMetadata,
            error: {
                code: 'outside_workspace',
                message: 'denied',
            },
        },
    })

    assert.deepEqual(statuses, [
        {
            type: 'tool_denied',
            step: 1,
            callId: 'call-denied',
            toolName: 'read_file',
        },
    ])
})

test('maps timeout and all other unsuccessful tool results', () => {
    const { renderer, statuses } = createRendererFixture(true)
    const cases = [
        ['timeout', 'tool_timeout'],
        ['invalid_arguments', 'tool_failed'],
        ['unknown_tool', 'tool_failed'],
        ['execution_error', 'tool_failed'],
        ['aborted', 'tool_failed'],
    ] as const

    for (const [resultStatus, expectedStatus] of cases) {
        const callId = `call-${resultStatus}`

        renderer.onEvent({
            type: 'tool_requested',
            step: 3,
            call: {
                id: callId,
                name: 'untrusted_tool_name',
                arguments: {
                    secret: 'must not be rendered',
                },
            },
        })
        renderer.onEvent({
            type: 'tool_completed',
            step: 3,
            result: {
                status: resultStatus,
                callId,
                content: 'unrestricted result content',
                metadata: completeMetadata,
                error: {
                    code: resultStatus,
                    message: 'unsanitized error',
                },
            },
        })

        assert.deepEqual(statuses.at(-1), {
            type: expectedStatus,
            step: 3,
            callId,
            toolName: 'untrusted_tool_name',
        })
    }

    assert.equal(statuses.length, cases.length)
})

test('ignores unmatched authorization and completion events', () => {
    const { renderer, statuses } = createRendererFixture(false)

    renderer.onEvent({
        type: 'tool_authorized',
        step: 1,
        callId: 'missing',
        decision: {
            decision: 'allow',
        },
    })
    renderer.onEvent({
        type: 'tool_completed',
        step: 1,
        result: {
            status: 'success',
            callId: 'missing',
            content: '',
            metadata: completeMetadata,
        },
    })

    assert.deepEqual(statuses, [])
})
