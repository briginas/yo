import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createRunRecord,
    projectRunEvent,
    finalizeRunRecord,
    failRunRecord,
} from './run-observation.ts'
import { createTerminalStatusOutput } from './terminal-renderer.ts'
import {
    createTerminalObservationView,
    formatObservationResult,
    formatObservationDiagnostic,
} from './terminal-observation.ts'

const clock = { wallTimeMs: new Date(2026, 9, 2, 12, 0, 0).getTime(), monotonicTimeMs: 100 }
const base = () => createRunRecord(1, 'Inspect repository', clock)

test('renders a deterministic header, one ordered feed, and textual activity without terminal controls in non-TTY', () => {
    const lines: string[] = []
    const cards: string[] = []
    const output = createTerminalStatusOutput({
        write: (value) => lines.push(value),
        clearLine: () => {
            throw new Error('must not clear')
        },
        moveCursorToStart: () => {
            throw new Error('must not move')
        },
        isInteractive: false,
    })
    const view = createTerminalObservationView(output, (value) => cards.push(value))
    const record = base()
    view.start(record)
    const next = projectRunEvent(
        record,
        1,
        {
            type: 'model_requested',
            step: 1,
            metadata: { model: null, visibleTools: ['read_file'] },
        },
        { ...clock, monotonicTimeMs: 125 }
    )
    view.event(next, next.feed[0]!)
    view.event(next, null)
    assert.deepEqual(lines, [
        'Run #1: Inspect repository | start=12:00:00\n',
        'state: run=1 starting elapsed=0.000s\n',
        'event: run=1 #1 model_requested step=1\n',
        'state: run=1 model elapsed=0.025s\n',
    ])
    const settled = finalizeRunRecord(
        next,
        1,
        {
            status: 'completed',
            stopReason: 'final_answer',
            finalAnswer: 'Do not print a second answer',
        },
        { ...clock, monotonicTimeMs: 200 }
    )
    view.settled(settled, [settled])
    assert.equal(
        cards[0],
        [
            'Run #1 result: completed',
            'Elapsed: 0.100s',
            'Evidence:',
            'Stop reason: final_answer',
            'Tools: (none)',
            'Files:',
            '- (none)',
            'Errors:',
            '- (none)',
            'Patches:',
            '- (none)',
            'Session runs:',
            '- #1 Inspect repository | completed | start=12:00:00 elapsed=0.100s',
        ].join('\n')
    )
    assert.doesNotMatch(cards.join(''), /Do not print|\u001b/)
})

test('interactive output replaces activity, clears before durable feed and result, and does not use color', () => {
    const operations: string[] = []
    const output = createTerminalStatusOutput({
        write: (value) => operations.push(value),
        clearLine: () => operations.push('clear'),
        moveCursorToStart: () => operations.push('cursor'),
        isInteractive: true,
    })
    const view = createTerminalObservationView(output, (value) => operations.push(value))
    const record = base()
    view.start(record)
    assert.deepEqual(operations.slice(-3), [
        'clear',
        'cursor',
        'state: run=1 starting elapsed=0.000s',
    ])
    const next = projectRunEvent(
        record,
        1,
        { type: 'model_requested', step: 1, metadata: { model: null, visibleTools: [] } },
        clock
    )
    view.event(next, next.feed[0]!)
    assert.deepEqual(operations.slice(-6, -3), [
        'clear',
        'cursor',
        'event: run=1 #1 model_requested step=1\n',
    ])
    const settled = failRunRecord(next, 1, clock)
    view.settled(settled, [settled])
    assert.deepEqual(operations.slice(-3, -1), ['clear', 'cursor'])
    assert.match(operations.at(-1)!, /result: failed/)
    assert.match(operations.at(-1)!, /cli_turn_error/)
    assert.doesNotMatch(operations.join(''), /\u001b/)
})

test('shows safe call numbers and complete patch outcome trail without IDs or patch contents', () => {
    let record = base()
    record = projectRunEvent(
        record,
        1,
        {
            type: 'tool_requested',
            step: 1,
            call: {
                id: 'Bearer private-id',
                name: 'propose_patch',
                arguments: { private: 'text' },
            },
        },
        clock
    )
    const metadata = {
        proposalId: 'private proposal',
        relativePath: 'src/file.ts',
        baseHash: 'private-base',
        nextHash: 'private-next',
        addedLineCount: 1,
        removedLineCount: 1,
    }
    for (const event of [
        { type: 'patch_prepared', step: 1, callId: 'Bearer private-id', metadata },
        { type: 'patch_approval_requested', step: 1, callId: 'Bearer private-id', metadata },
        {
            type: 'patch_approval_resolved',
            step: 1,
            callId: 'Bearer private-id',
            metadata,
            decision: 'approved',
        },
        { type: 'patch_applied', step: 1, callId: 'Bearer private-id', metadata },
    ] as const)
        record = projectRunEvent(record, 1, event, clock)
    const settled = finalizeRunRecord(
        record,
        1,
        { status: 'completed', stopReason: 'final_answer', finalAnswer: null },
        clock
    )
    const rendered = formatObservationResult(settled, [settled])
    assert.match(rendered, /src\/file.ts: prepared -> waiting -> approved -> applied/)
    assert.doesNotMatch(rendered, /private|Bearer/)
})

test('fixed diagnostics reveal no raw errors', () => {
    assert.equal(
        formatObservationDiagnostic('missing_record'),
        'Observation: run record is missing.'
    )
    assert.equal(
        formatObservationDiagnostic('projection_failed'),
        'Observation: event projection failed.'
    )
    assert.equal(
        formatObservationDiagnostic('observer_failed'),
        'Observation: answer observer failed.'
    )
    assert.equal(formatObservationDiagnostic('rendering_failed'), 'Observation: display failed.')
})

test('unavailable timing never appears as an invented timestamp or duration', () => {
    const record = { ...base(), timingAvailable: false }
    const lines: string[] = []
    const output = createTerminalStatusOutput({
        write: (line) => lines.push(line),
        clearLine: () => undefined,
        moveCursorToStart: () => undefined,
        isInteractive: false,
    })
    createTerminalObservationView(output, () => undefined).start(record)
    assert.match(lines[0]!, /start=unavailable/)
    assert.match(lines[1]!, /elapsed=unavailable/)
    const settled = failRunRecord(record, 1, clock)
    assert.match(formatObservationResult(settled, [settled]), /Elapsed: unavailable/)
    assert.doesNotMatch(lines.join(''), /12:00:00|0.000s/)
})

test('feed warns about each supported truncation reason and preserves the flag without details', () => {
    const lines: string[] = []
    const output = createTerminalStatusOutput({
        write: (line) => lines.push(line),
        clearLine: () => undefined,
        moveCursorToStart: () => undefined,
        isInteractive: false,
    })
    const view = createTerminalObservationView(output, () => undefined)
    for (const reason of ['line_limit', 'byte_limit', 'result_limit', null] as const) {
        const record = projectRunEvent(
            base(),
            1,
            {
                type: 'tool_completed',
                step: 1,
                result: {
                    status: 'success',
                    callId: 'read',
                    content: 'private contents',
                    metadata: {
                        truncated: true,
                        truncation:
                            reason === null ? null : { reason, limit: 2000, observed: 2001 },
                    },
                },
            },
            clock
        )
        view.event(record, record.feed[0]!)
        const line = lines.at(-2)!
        assert.match(line, /outcome=success truncated=true/)
        if (reason === null) assert.doesNotMatch(line, / reason=| limit=| observed=/)
        else assert.equal(line.endsWith(`reason=${reason} limit=2000 observed=2001\n`), true)
        assert.doesNotMatch(line, /private contents/)
    }
})
