import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    createTerminalRenderer,
    formatTerminalStatusLine,
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
            argumentSummary: 'path="src/cli.ts"',
            truncation: null,
        },
        {
            type: 'tool_completed',
            step: 2,
            callId: 'call-1',
            toolName: 'read_file',
            argumentSummary: 'path="src/cli.ts"',
            truncation: null,
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
            argumentSummary: 'path="../outside.txt"',
            truncation: null,
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
            toolName: 'unknown_tool',
            argumentSummary: null,
            truncation: null,
        })
        const line = formatTerminalStatusLine(statuses.at(-1)!)

        assert.equal(
            line,
            `status: ${expectedStatus} step=3 tool=unknown_tool arguments=unavailable`
        )
        assert.doesNotMatch(
            line,
            /unrestricted result content|unsanitized error|must not be rendered/
        )
    }

    assert.equal(statuses.length, cases.length)
})

test('formats deterministic model and turn status lines', () => {
    const statuses: TerminalStatus[] = [
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
    ]

    assert.deepEqual(statuses.map(formatTerminalStatusLine), [
        'status: model_waiting step=1',
        'status: model_ready step=1',
        'status: turn_finished status=completed reason=final_answer',
    ])
})

test('formats validated arguments for every read-only tool in field order', () => {
    const { renderer, statuses } = createRendererFixture(false)
    const calls = [
        {
            id: 'list-call',
            name: 'list_files',
            arguments: {
                path: 'src',
                glob: '**/*.ts',
                limit: 20,
            },
        },
        {
            id: 'search-call',
            name: 'search_code',
            arguments: {
                query: 'needle',
                path: 'src',
                glob: '*.ts',
                limit: 10,
            },
        },
        {
            id: 'read-call',
            name: 'read_file',
            arguments: {
                path: 'src/cli.ts',
                startLine: 10,
                endLine: 20,
            },
        },
    ] as const

    for (const call of calls) {
        renderer.onEvent({
            type: 'tool_requested',
            step: 2,
            call,
        })
        renderer.onEvent({
            type: 'tool_authorized',
            step: 2,
            callId: call.id,
            decision: {
                decision: 'allow',
            },
        })
    }

    assert.deepEqual(statuses.map(formatTerminalStatusLine), [
        'status: tool_running step=2 tool=list_files path="src" glob="**/*.ts" limit=20',
        'status: tool_running step=2 tool=search_code query="needle" path="src" glob="*.ts" limit=10',
        'status: tool_running step=2 tool=read_file path="src/cli.ts" lines=10-20',
    ])
})

test('formats partial read ranges and omits absent optional filters', () => {
    const { renderer, statuses } = createRendererFixture(false)
    const calls = [
        {
            id: 'read-start',
            name: 'read_file',
            arguments: {
                path: 'src/start.ts',
                startLine: 8,
            },
        },
        {
            id: 'read-end',
            name: 'read_file',
            arguments: {
                path: 'src/end.ts',
                endLine: 12,
            },
        },
        {
            id: 'list-minimal',
            name: 'list_files',
            arguments: {
                path: '.',
            },
        },
    ] as const

    for (const call of calls) {
        renderer.onEvent({
            type: 'tool_requested',
            step: 1,
            call,
        })
        renderer.onEvent({
            type: 'tool_authorized',
            step: 1,
            callId: call.id,
            decision: {
                decision: 'allow',
            },
        })
    }

    assert.deepEqual(statuses.map(formatTerminalStatusLine), [
        'status: tool_running step=1 tool=read_file path="src/start.ts" lines=8-*',
        'status: tool_running step=1 tool=read_file path="src/end.ts" lines=*-12',
        'status: tool_running step=1 tool=list_files path="."',
    ])
})

test('bounds string previews, keeps them on one line, and escapes quotes', () => {
    const { renderer, statuses } = createRendererFixture(false)
    const longQuery = `line one\n${'x'.repeat(100)} "quoted" \\ path`

    renderer.onEvent({
        type: 'tool_requested',
        step: 1,
        call: {
            id: 'long-search',
            name: 'search_code',
            arguments: {
                query: longQuery,
            },
        },
    })
    renderer.onEvent({
        type: 'tool_authorized',
        step: 1,
        callId: 'long-search',
        decision: {
            decision: 'allow',
        },
    })

    const status = statuses[0]

    assert.ok(status !== undefined && 'argumentSummary' in status)

    const line = formatTerminalStatusLine(status)

    assert.equal(
        line,
        `status: tool_running step=1 tool=search_code query="line one ${'x'.repeat(68)}..."`
    )
    assert.doesNotMatch(line, /[\r\n\u001b]/)
    assert.equal([...status.argumentSummary!.slice('query="'.length, -1)].length, 80)
})

test('redacts credential-like values before creating tool summaries', () => {
    const { renderer, statuses } = createRendererFixture(false)
    const sensitiveValues = [
        'Authorization: private',
        'Bearer private',
        'access_token=private',
        'refresh_token=private',
        'client_secret=private',
        'sk-private',
    ]

    for (const [index, query] of sensitiveValues.entries()) {
        const callId = `sensitive-${index}`

        renderer.onEvent({
            type: 'tool_requested',
            step: 1,
            call: {
                id: callId,
                name: 'search_code',
                arguments: {
                    query,
                    path: 'src',
                },
            },
        })
        renderer.onEvent({
            type: 'tool_authorized',
            step: 1,
            callId,
            decision: {
                decision: 'allow',
            },
        })
    }

    assert.deepEqual(
        statuses.map(formatTerminalStatusLine),
        sensitiveValues.map(
            () => 'status: tool_running step=1 tool=search_code query=<redacted> path="src"'
        )
    )

    for (const line of statuses.map(formatTerminalStatusLine)) {
        assert.doesNotMatch(
            line,
            /private|authorization|bearer|access_token|refresh_token|client_secret|sk-/i
        )
    }
})

test('does not expose invalid known-tool arguments', () => {
    const { renderer, statuses } = createRendererFixture(false)

    renderer.onEvent({
        type: 'tool_requested',
        step: 1,
        call: {
            id: 'invalid-read',
            name: 'read_file',
            arguments: {
                path: 'src/cli.ts',
                secret: 'private argument',
            },
        },
    })
    renderer.onEvent({
        type: 'tool_completed',
        step: 1,
        result: {
            status: 'invalid_arguments',
            callId: 'invalid-read',
            content: 'raw validation details',
            metadata: completeMetadata,
            error: {
                code: 'invalid_arguments',
                message: 'raw validation error',
            },
        },
    })

    const line = formatTerminalStatusLine(statuses[0]!)

    assert.equal(line, 'status: tool_failed step=1 tool=read_file arguments=unavailable')
    assert.doesNotMatch(line, /src\/cli|private|raw validation/)
})

test('formats every truncation reason without result content or errors', () => {
    const { renderer, statuses } = createRendererFixture(false)
    const reasons = ['byte_limit', 'line_limit', 'result_limit'] as const

    for (const [index, reason] of reasons.entries()) {
        const callId = `truncated-${reason}`

        renderer.onEvent({
            type: 'tool_requested',
            step: 4,
            call: {
                id: callId,
                name: 'list_files',
                arguments: {
                    path: 'src',
                },
            },
        })
        renderer.onEvent({
            type: 'tool_completed',
            step: 4,
            result: {
                status: 'success',
                callId,
                content: `private result ${reason}`,
                metadata: {
                    truncated: true,
                    truncation: {
                        reason,
                        limit: index + 10,
                        observed: index + 20,
                    },
                },
            },
        })
    }

    assert.deepEqual(statuses.map(formatTerminalStatusLine), [
        'status: tool_completed step=4 tool=list_files path="src" truncated=byte_limit limit=10 observed=20',
        'status: tool_completed step=4 tool=list_files path="src" truncated=line_limit limit=11 observed=21',
        'status: tool_completed step=4 tool=list_files path="src" truncated=result_limit limit=12 observed=22',
    ])

    for (const line of statuses.map(formatTerminalStatusLine)) {
        assert.doesNotMatch(line, /private result/)
    }
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
