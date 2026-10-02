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
    formatObservationList,
    formatObservationInspection,
    formatObservationDiagnostic,
    formatObservationState,
} from './terminal-observation.ts'

const clock = { wallTimeMs: new Date(2026, 9, 2, 12, 0, 0).getTime(), monotonicTimeMs: 100 }
const base = () => createRunRecord(1, 'Inspect repository', clock)

test('TTY and non-TTY show requested cancellation until settlement and retain applied evidence', () => {
    for (const isInteractive of [true, false]) {
        const lines: string[] = []
        const controls: string[] = []
        const cards: string[] = []
        const output = createTerminalStatusOutput({
            write: (value) => lines.push(value),
            clearLine: () => controls.push('clear'),
            moveCursorToStart: () => controls.push('cursor'),
            isInteractive,
        })
        const view = createTerminalObservationView(output, (value) => cards.push(value))
        let record = base()
        view.start(record)
        const metadata = {
            proposalId: 'private-proposal',
            relativePath: 'src/file.ts',
            baseHash: 'private-base',
            nextHash: 'private-next',
            addedLineCount: 1,
            removedLineCount: 1,
        }
        const events = [
            { type: 'patch_prepared', step: 1, callId: 'private-call', metadata },
            { type: 'patch_approval_requested', step: 1, callId: 'private-call', metadata },
            {
                type: 'patch_approval_resolved',
                step: 1,
                callId: 'private-call',
                metadata,
                decision: 'approved',
            },
            { type: 'run_cancellation_requested' },
            { type: 'patch_applied', step: 1, callId: 'private-call', metadata },
            { type: 'run_finished', status: 'aborted', reason: 'aborted' },
        ] as const
        for (const event of events) {
            record = projectRunEvent(record, 1, event, { ...clock, monotonicTimeMs: 125 })
            view.event(record, record.feed.at(-1)!)
        }
        assert.equal(cards.length, 0)
        assert.match(lines.at(-1)!, /cancellation requested elapsed=0.025s/)
        assert.equal(record.summary.status, 'running')
        assert.equal(
            projectRunEvent(record, 1, { type: 'run_cancellation_requested' }, clock),
            record
        )
        view.event(record, null)
        assert.equal(lines.filter((line) => line.includes('run_cancellation_requested')).length, 1)
        assert.equal(lines.filter((line) => line.includes('cancellation requested')).length, 3)
        const settled = finalizeRunRecord(
            record,
            1,
            {
                status: 'aborted',
                stopReason: 'aborted',
                finalAnswer: null,
            },
            { ...clock, monotonicTimeMs: 200 }
        )
        view.settled(settled, [settled])
        assert.match(cards[0]!, /Run #1 result: cancelled/)
        assert.match(cards[0]!, /\| cancelled \|.*elapsed=0.100s.*reason=aborted/)
        assert.match(cards[0]!, /src\/file.ts: prepared -> waiting -> approved -> applied/)
        const retained = formatObservationInspection([settled], 1)
        assert.match(retained, /run_cancellation_requested/)
        assert.match(retained, /Retained answer:\n\(no final answer\)/)
        assert.match(retained, /result: cancelled/)
        assert.match(formatObservationState(settled), /cancelled elapsed=0.100s/)
        assert.equal(controls.length > 0, isInteractive)
        if (!isInteractive)
            assert.equal(
                lines.every((line) => line.endsWith('\n')),
                true
            )
        assert.doesNotMatch(lines.join('') + cards.join('') + retained, /private-|\u001b/)
    }
})

test('cancelled labels require aborted/aborted settlement and never override race winners', () => {
    const record = projectRunEvent(base(), 1, { type: 'run_cancellation_requested' }, clock)
    for (const [status, stopReason, label] of [
        ['completed', 'final_answer', 'completed'],
        ['aborted', 'step_budget_exhausted', 'budget_exhausted'],
        ['failed', 'transport_error', 'failed'],
        ['aborted', 'final_answer', 'aborted'],
    ] as const) {
        const settled = finalizeRunRecord(
            record,
            1,
            { status, stopReason, finalAnswer: null },
            clock
        )
        for (const rendered of [
            formatObservationResult(settled, [settled]),
            formatObservationInspection([settled], 1),
            formatObservationList([settled]),
            formatObservationState(settled),
        ]) {
            assert.ok(rendered.includes(label))
            assert.doesNotMatch(rendered, /cancelled/)
        }
    }
})

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
            '- #1 Inspect repository | completed | start=12:00:00 elapsed=0.100s | reason=final_answer',
            'Inspect: /run N | List: /runs',
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

test('inspection selects immutable evidence and marks retained answers and missing selections', () => {
    let record = createRunRecord(1, 'Inspect\u001b[31m task', clock)
    for (const id of ['private-first', 'private-second']) {
        record = projectRunEvent(
            record,
            1,
            {
                type: 'tool_requested',
                step: 1,
                call: { id, name: 'read_file', arguments: { path: 'file.ts' } },
            },
            clock
        )
        record = projectRunEvent(
            record,
            1,
            {
                type: 'tool_completed',
                step: 1,
                result: {
                    callId: id,
                    status: 'success',
                    content: 'RAW CONTENT',
                    metadata: {
                        truncated: id === 'private-first',
                        truncation: { reason: 'line_limit', limit: 2, observed: 3 },
                    },
                },
            },
            clock
        )
    }
    const first = finalizeRunRecord(
        record,
        1,
        {
            status: 'completed',
            stopReason: 'final_answer',
            finalAnswer: 'x'.repeat(17000),
        },
        { ...clock, monotonicTimeMs: 200 }
    )
    const second = finalizeRunRecord(
        createRunRecord(2, 'Other task', clock),
        2,
        {
            status: 'failed',
            stopReason: 'transport_error',
            finalAnswer: null,
        },
        clock
    )
    const history = [first, second]
    const before = structuredClone(history)
    const view = formatObservationInspection(history, 1)
    assert.match(view, /#1 tool_requested step=1 call=1/)
    assert.match(view, /#3 tool_requested step=1 call=2/)
    assert.match(view, /truncated=true reason=line_limit limit=2 observed=3/)
    assert.match(view, /Retained answer:\nx{15999}…\n\[Answer preview truncated\]/)
    assert.match(view, /Elapsed: 0.100s/)
    assert.doesNotMatch(view, /RAW CONTENT|private-|Other task|Session runs:|\u001b/)
    assert.match(formatObservationInspection(history, 2), /no final answer/)
    assert.match(formatObservationInspection(history, 2), /transport_error/)
    assert.equal(formatObservationInspection(history, 1), view)
    assert.deepEqual(history, before)
    assert.match(formatObservationInspection(history, 3), /unavailable/)
    assert.match(formatObservationInspection([base()], 1), /not settled/)
    assert.match(formatObservationList([]), /No runs yet/)
    const list = formatObservationList(history)
    assert.ok(list.indexOf('#1') < list.indexOf('#2'))
    assert.match(list, /reason=final_answer/)
    assert.match(list, /reason=transport_error/)
    assert.doesNotMatch(list, /Retained answer|event:|xxx/)
    assert.doesNotMatch(formatObservationResult(first, history), /xxx/)
})

test('inspection uses safe retained previews and unavailable timing', () => {
    const record = finalizeRunRecord(
        createRunRecord(1, 'Bearer secret', clock),
        1,
        {
            status: 'completed',
            stopReason: 'final_answer',
            finalAnswer: 'Bearer secret answer',
        },
        clock
    )
    const view = formatObservationInspection([{ ...record, timingAvailable: false }], 1)
    assert.match(view, /Retained answer:\n<redacted>/)
    assert.match(view, /start=unavailable/)
    assert.match(view, /Elapsed: unavailable/)
    assert.doesNotMatch(view, /secret|12:00:00|0.000s/)
})
