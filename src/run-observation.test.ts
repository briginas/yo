import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createRunRecord,
    finalizeRunRecord,
    projectRunEvent,
    updateObservedRun,
    type RunRecord,
} from './run-observation.ts'
import type { RunEventSnapshot } from './runtime/run.ts'
import type { ToolResultStatus } from './runtime/tools.ts'

const clock = (monotonicTimeMs: number, wallTimeMs = 1000) => ({ monotonicTimeMs, wallTimeMs })
const initial = (id = 1) => createRunRecord(id, 'Inspect repository', clock(100))
const project = (record: RunRecord, event: RunEventSnapshot, time = 110) =>
    projectRunEvent(record, record.summary.id, event, clock(time))
const request = (id: string, step = 1): RunEventSnapshot => ({
    type: 'tool_requested',
    step,
    call: { id, name: 'read_file', arguments: { path: 'src/main.ts' } },
})
const completed = (callId: string, status: ToolResultStatus, step = 1): RunEventSnapshot => ({
    type: 'tool_completed',
    step,
    result:
        status === 'success'
            ? {
                  callId,
                  status,
                  content: 'private file contents',
                  metadata: { truncated: false, truncation: null },
              }
            : {
                  callId,
                  status,
                  content: 'raw diagnostics',
                  metadata: { truncated: false, truncation: null },
                  error: { code: 'private-code', message: 'Bearer private-token' },
              },
})
const settle = (record: RunRecord, time = 150) =>
    finalizeRunRecord(
        record,
        record.summary.id,
        { status: 'completed', stopReason: 'final_answer', finalAnswer: 'Done' },
        clock(time)
    )
const metadata = {
    proposalId: 'proposal',
    relativePath: 'src/main.ts',
    baseHash: 'base',
    nextHash: 'next',
    addedLineCount: 1,
    removedLineCount: 1,
}

test('preserves call order and step association without retaining raw data or answer deltas', () => {
    const events: RunEventSnapshot[] = [
        {
            type: 'model_requested',
            step: 1,
            metadata: { model: null, visibleTools: ['read_file'] },
        },
        {
            type: 'model_responded',
            step: 1,
            metadata: { model: null, toolCallCount: 2, hasFinalAnswer: false },
        },
        request('first'),
        request('second'),
        { type: 'tool_authorized', step: 1, callId: 'first', decision: { decision: 'allow' } },
        completed('first', 'success'),
        completed('second', 'timeout'),
        request('first', 2),
        completed('first', 'execution_error', 2),
    ]
    const original = initial()
    const record = events.reduce((record, event) => project(record, event), original)
    assert.equal(original.feed.length, 0)
    assert.deepEqual(
        record.feed.map((row) => row.sequence),
        [1, 2, 3, 4, 5, 6, 7, 8, 9]
    )
    assert.deepEqual(
        record.feed.slice(-2).map((row) => [row.step, row.callId, row.tool]),
        [
            [2, 'first', 'read_file'],
            [2, 'first', 'read_file'],
        ]
    )
    assert.deepEqual(record.files, ['src/main.ts'])
    assert.deepEqual(record.tools, ['read_file'])
    assert.equal(record.summary.status, 'running')
    assert.equal(project(record, { type: 'final_answer_delta', delta: 'private answer' }), record)
    assert.equal(project(record, { type: 'final_answer', answer: 'private answer' }), record)
    assert.doesNotMatch(JSON.stringify(record), /private|raw diagnostics|Bearer/)
    assert.deepEqual(
        record.errors.map((error) => error.reason),
        ['timeout', 'execution_error']
    )
})

test('records distinct tool failures without failing the whole run', () => {
    for (const status of [
        'invalid_arguments',
        'unknown_tool',
        'denied',
        'timeout',
        'execution_error',
        'aborted',
    ] as const) {
        const record = project(project(initial(), request('call')), completed('call', status))
        assert.equal(record.feed.at(-1)?.outcome, status)
        assert.equal(record.errors[0]?.reason, status)
        assert.equal(settle(record).summary.status, 'completed')
    }
})

test('projects patch preparation, waiting, decisions, conflict and application separately', () => {
    for (const decision of ['approved', 'denied', 'aborted'] as const) {
        let record = project(initial(), {
            type: 'patch_prepared',
            step: 1,
            callId: 'patch',
            metadata,
        })
        assert.equal(record.approvals[0]?.state, 'prepared')
        record = project(record, {
            type: 'patch_approval_requested',
            step: 1,
            callId: 'patch',
            metadata,
        })
        assert.equal(record.summary.activity, 'approval')
        assert.equal(record.summary.status, 'running')
        record = project(record, {
            type: 'patch_approval_resolved',
            step: 1,
            callId: 'patch',
            metadata,
            decision,
        })
        assert.equal(record.summary.activity, 'tools')
        assert.equal(record.approvals[0]?.state, decision)
        record = project(
            record,
            decision === 'approved'
                ? { type: 'patch_applied', step: 1, callId: 'patch', metadata }
                : {
                      type: 'patch_conflicted',
                      step: 1,
                      callId: 'patch',
                      metadata,
                      conflict: 'base_changed',
                  }
        )
        assert.deepEqual(
            record.feed.map((row) => row.outcome),
            ['prepared', 'waiting', decision, decision === 'approved' ? 'applied' : 'conflict']
        )
        assert.equal(
            settle(record).result?.approvals[0]?.state,
            decision === 'approved' ? 'applied' : 'conflict'
        )
    }
})

test('settles from actual session once, preserves partial feed and distinguishes stop reasons', () => {
    const record = project(initial(), request('call'))
    for (const [status, stopReason, outcome] of [
        ['completed', 'final_answer', 'completed'],
        ['failed', 'transport_error', 'failed'],
        ['aborted', 'step_budget_exhausted', 'budget_exhausted'],
        ['aborted', 'aborted', 'aborted'],
    ] as const) {
        const settled = finalizeRunRecord(
            record,
            1,
            { status, stopReason, finalAnswer: null },
            clock(150)
        )
        assert.equal(settled.summary.status, outcome)
        assert.equal(settled.result?.stopReason, stopReason)
        assert.equal(settled.feed.length, 1)
        assert.equal(settle(settled, 999), settled)
        assert.equal(project(settled, request('late'), 999), settled)
        assert.equal(settled.summary.elapsedMs, 50)
        assert.equal(
            settled.result?.errors.some((error) => error.reason === 'transport_error'),
            stopReason === 'transport_error'
        )
    }
    assert.equal(
        finalizeRunRecord(
            record,
            1,
            { status: 'running', stopReason: null, finalAnswer: null },
            clock(150)
        ),
        record
    )
    const finishedEvent = project(record, {
        type: 'run_finished',
        status: 'completed',
        reason: 'final_answer',
    })
    assert.equal(finishedEvent.summary.status, 'running')
    assert.equal(finishedEvent.summary.activity, 'finishing')
})

test('isolates runs with repeated names and late observers', () => {
    const first = settle(project(initial(), request('same')))
    const second = initial(2)
    const history = updateObservedRun([first, second], 2, (record) =>
        project(record, request('same'))
    )
    assert.equal(history[0], first)
    assert.equal(history[1]?.feed[0]?.runId, 2)
    let called = false
    const late = updateObservedRun(history, 1, (record) => {
        called = true
        return project(record, request('late'))
    })
    assert.equal(called, false)
    assert.deepEqual(late, history)
    assert.equal(projectRunEvent(second, 1, request('wrong'), clock(200)), second)
    assert.equal(
        finalizeRunRecord(
            second,
            1,
            { status: 'completed', stopReason: 'final_answer', finalAnswer: 'wrong' },
            clock(200)
        ),
        second
    )
})

test('uses only injected monotonic time and freezes duration despite wall-clock changes', () => {
    const record = initial()
    const forward = projectRunEvent(record, 1, request('first'), clock(130, -5000))
    const backward = projectRunEvent(forward, 1, request('second'), clock(90, 999999))
    assert.equal(backward.summary.startedAtMs, 1000)
    assert.equal(backward.summary.elapsedMs, 30)
    const settled = settle(backward, 120)
    assert.equal(settled.summary.elapsedMs, 30)
    assert.equal(project(settled, request('late'), 10000).summary.elapsedMs, 30)
    assert.equal(
        projectRunEvent(record, 1, request('first'), clock(Number.NaN)).summary.elapsedMs,
        0
    )
})

test('bounds and sanitizes previews and rejects invalid read argument shapes', () => {
    const record = createRunRecord(1, '\u001b[31m' + 'x'.repeat(1000), clock(0))
    assert.equal([...record.summary.taskPreview].length, 160)
    assert.doesNotMatch(record.summary.taskPreview, /\u001b/)
    assert.equal(createRunRecord(1, 'Bearer secret', clock(0)).summary.taskPreview, '<redacted>')
    const invalid = project(record, {
        type: 'tool_requested',
        step: 1,
        call: { id: 'invalid', name: 'read_file', arguments: { path: 'src/a', unexpected: true } },
    })
    assert.equal(invalid.calls[0]?.readPath, null)
    assert.equal(settle(record).result?.answer, 'Done')
    assert.throws(() => createRunRecord(0, 'task', clock(0)))
    assert.throws(() => createRunRecord(1, 'task', clock(Infinity)))
})

test('collects bounded file evidence from successful list and search calls only', () => {
    let record = project(initial(), {
        type: 'tool_requested',
        step: 1,
        call: { id: 'list', name: 'list_files', arguments: { path: '.' } },
    })
    record = project(record, {
        type: 'tool_completed',
        step: 1,
        result: {
            status: 'success',
            callId: 'list',
            content: 'src/\nsrc/a.ts\nsrc/b.ts',
            metadata: { truncated: false, truncation: null },
        },
    })
    record = project(record, {
        type: 'tool_requested',
        step: 2,
        call: { id: 'search', name: 'search_code', arguments: { query: 'private' } },
    })
    record = project(record, {
        type: 'tool_completed',
        step: 2,
        result: {
            status: 'success',
            callId: 'search',
            content: 'src/b.ts:12:private source\nsrc/c.ts:2:private source',
            metadata: { truncated: false, truncation: null },
        },
    })
    assert.deepEqual(record.files, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
    assert.doesNotMatch(JSON.stringify(record), /private source/)
    const settled = finalizeRunRecord(
        record,
        1,
        { status: 'completed', stopReason: 'final_answer', finalAnswer: 'First line\nSecond line' },
        clock(150)
    )
    assert.equal(settled.result?.answer, 'First line\nSecond line')
    assert.equal(settled.result?.answerTruncated, false)
    const longAnswer = finalizeRunRecord(
        initial(),
        1,
        { status: 'completed', stopReason: 'final_answer', finalAnswer: 'x'.repeat(20000) },
        clock(150)
    )
    assert.equal(longAnswer.result?.answerTruncated, true)
    assert.equal(longAnswer.result?.answer?.length, 16000)
})

test('shows permission denial and final-answer activity without executing or reopening runs', () => {
    let record = project(initial(), request('denied'))
    record = project(record, {
        type: 'tool_authorized',
        step: 1,
        callId: 'denied',
        decision: { decision: 'deny', reason: 'sensitive_path' },
    })
    assert.equal(record.feed.at(-1)?.outcome, 'deny')
    assert.deepEqual(record.tools, [])
    record = project(record, {
        type: 'model_responded',
        step: 2,
        metadata: { model: null, toolCallCount: 0, hasFinalAnswer: true },
    })
    assert.equal(record.summary.activity, 'finishing')
    const unrelated = updateObservedRun([record], 1, () => initial(2))
    assert.equal(unrelated[0], record)
    const unknown = project(initial(), {
        type: 'tool_requested',
        step: 1,
        call: { id: 'unknown', name: 'Bearer private-tool-name', arguments: 'private arguments' },
    })
    assert.equal(unknown.feed[0]?.tool, 'unknown_tool')
    assert.doesNotMatch(JSON.stringify(unknown), /private/)
})
