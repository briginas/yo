import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createRunRecord,
    failRunRecord,
    finalizeRunRecord,
    projectRunEvent,
    updateObservedRun,
    type RunRecord,
} from './run-observation.ts'
import type { RerunProvenance } from './chat-runs.ts'
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

test('rerun provenance is a detached immutable allowlist through projection and settlement', () => {
    assert.equal(initial().rerun, null)
    const supplied = {
        sourceId: 2,
        contextPolicy: 'current_conversation' as const,
        task: 'private complete task',
        windowId: 7,
        action: { line: '/rerun 2', windowId: 7 },
        transcript: ['private messages'],
        proposal: { contents: 'private patch' },
        approval: 'approved',
    }
    const record = createRunRecord(3, 'Visible task', clock(100), supplied)
    assert.deepEqual(record.rerun, { sourceId: 2, contextPolicy: 'current_conversation' })
    assert.notEqual(record.rerun, supplied)
    assert.ok(Object.isFrozen(record.rerun))
    supplied.sourceId = 99
    Object.assign(supplied, { contextPolicy: 'private policy' })
    supplied.transcript.push('later message')
    const projected = project(record, request('new-call'))
    assert.equal(Reflect.set(record, 'rerun', null), false)
    assert.equal(Reflect.set(projected, 'rerun', supplied), false)
    assert.equal(projected.rerun, record.rerun)
    assert.equal(projected.rerun?.sourceId, 2)
    assert.throws(() => Object.assign(projected.rerun!, { sourceId: 99 }), TypeError)
    for (const [status, stopReason] of [
        ['completed', 'final_answer'],
        ['failed', 'transport_error'],
        ['aborted', 'aborted'],
        ['aborted', 'step_budget_exhausted'],
    ] as const) {
        const settled = finalizeRunRecord(
            projected,
            3,
            { status, stopReason, finalAnswer: null },
            clock(150)
        )
        assert.equal(settled.rerun, record.rerun)
        assert.equal(Reflect.set(settled, 'rerun', null), false)
        assert.equal(project(settled, request('late'), 999), settled)
        assert.equal(settle(settled, 999), settled)
        assert.doesNotMatch(
            JSON.stringify(settled),
            /private|windowId|action|transcript|proposal|approval"/
        )
    }
    const failed = failRunRecord(projected, 3, clock(150))
    assert.equal(failed.rerun, record.rerun)
    assert.equal(Reflect.set(failed, 'rerun', null), false)
})

test('rerun provenance rejects invalid numbers and context policies without retaining raw fields', () => {
    for (const sourceId of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '1']) {
        assert.throws(() =>
            createRunRecord(2, 'Task', clock(100), {
                sourceId,
                contextPolicy: 'current_conversation',
            } as RerunProvenance)
        )
    }
    assert.throws(() =>
        createRunRecord(2, 'Task', clock(100), {
            sourceId: 1,
            contextPolicy: 'private policy',
        } as unknown as RerunProvenance)
    )
    assert.equal(
        createRunRecord(2, 'Task', clock(100), {
            sourceId: Number.MAX_SAFE_INTEGER,
            contextPolicy: 'current_conversation',
        }).rerun?.sourceId,
        Number.MAX_SAFE_INTEGER
    )
})

test('cancellation stays running and sticky through operation evidence with one request row', () => {
    const original = initial()
    let record = project(original, { type: 'run_cancellation_requested' }, 120)
    assert.equal(original.summary.activity, 'starting')
    assert.equal(record.summary.status, 'running')
    assert.equal(record.summary.activity, 'cancelling')
    assert.equal(record.result, null)
    assert.equal(project(record, { type: 'run_cancellation_requested' }, 999), record)
    const events: RunEventSnapshot[] = [
        { type: 'model_requested', step: 1, metadata: { model: null, visibleTools: [] } },
        {
            type: 'model_responded',
            step: 1,
            metadata: { model: null, toolCallCount: 1, hasFinalAnswer: false },
        },
        request('read'),
        completed('read', 'aborted'),
        { type: 'patch_prepared', step: 1, callId: 'patch', metadata },
        { type: 'patch_approval_requested', step: 1, callId: 'patch', metadata },
        {
            type: 'patch_approval_resolved',
            step: 1,
            callId: 'patch',
            metadata,
            decision: 'approved',
        },
        { type: 'patch_applied', step: 1, callId: 'patch', metadata },
        { type: 'run_finished', status: 'aborted', reason: 'aborted' },
    ]
    for (const [index, event] of events.entries()) {
        record = project(record, event, 130 + index)
        assert.equal(record.summary.activity, 'cancelling')
        assert.equal(record.summary.status, 'running')
        assert.equal(record.result, null)
        assert.equal(project(record, { type: 'run_cancellation_requested' }), record)
    }
    assert.deepEqual(
        record.feed.map((row) => row.type),
        ['run_cancellation_requested', ...events.map((event) => event.type)]
    )
    assert.deepEqual(
        record.feed.map((row) => row.sequence),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    )
    assert.deepEqual(record.errors, [{ step: 1, callId: 'read', reason: 'aborted' }])
    assert.deepEqual(record.files, ['src/main.ts'])
    assert.equal(record.approvals[0]?.state, 'applied')
})

test('settlement preserves runtime race winners and freezes requested cancellation history', () => {
    const requested = project(initial(), { type: 'run_cancellation_requested' }, 120)
    for (const [status, stopReason, outcome] of [
        ['completed', 'final_answer', 'completed'],
        ['failed', 'transport_error', 'failed'],
        ['aborted', 'step_budget_exhausted', 'budget_exhausted'],
        ['aborted', 'aborted', 'aborted'],
    ] as const) {
        const finished = project(requested, { type: 'run_finished', status, reason: stopReason })
        const settled = finalizeRunRecord(
            finished,
            1,
            { status, stopReason, finalAnswer: status === 'completed' ? 'Done' : null },
            clock(150)
        )
        const before = structuredClone(settled)
        assert.equal(settled.summary.status, outcome)
        assert.equal(settled.summary.activity, null)
        assert.equal(settled.result?.outcome, outcome)
        assert.equal(settled.summary.elapsedMs, 50)
        assert.equal(project(settled, { type: 'run_cancellation_requested' }, 999), settled)
        assert.equal(project(settled, request('late'), 999), settled)
        assert.equal(settle(settled, 999), settled)
        assert.deepEqual(settled, before)
    }
    const completedFirst = project(initial(), {
        type: 'run_finished',
        status: 'completed',
        reason: 'final_answer',
    })
    assert.equal(
        settle(project(completedFirst, { type: 'run_cancellation_requested' })).summary.status,
        'completed'
    )
})

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

test('search evidence never retains matched source text containing another line delimiter', () => {
    let record = project(initial(), {
        type: 'tool_requested',
        step: 1,
        call: { id: 'search', name: 'search_code', arguments: { query: 'marker' } },
    })
    record = project(record, {
        type: 'tool_completed',
        step: 1,
        result: {
            status: 'success',
            callId: 'search',
            content: 'src/a.ts:12:private_source_text:99:other text',
            metadata: { truncated: false, truncation: null },
        },
    })
    assert.deepEqual(record.files, ['src/a.ts'])
    assert.doesNotMatch(JSON.stringify(record), /private_source_text|other text/)
})

test('retains only detached safe truncation fields and handles absent or invalid details', () => {
    for (const reason of ['line_limit', 'byte_limit', 'result_limit'] as const) {
        const details = { reason, limit: 2000, observed: 2001, rawOutput: 'private metadata' }
        const event: RunEventSnapshot = {
            type: 'tool_completed',
            step: 1,
            result: {
                status: 'success',
                callId: 'read',
                content: 'private source',
                metadata: { truncated: true, truncation: details },
            },
        }
        const record = project(project(initial(), request('read')), event)
        assert.equal(record.feed.at(-1)?.truncated, true)
        assert.deepEqual(record.feed.at(-1)?.truncation, { reason, limit: 2000, observed: 2001 })
        details.observed = 9999
        assert.equal(record.feed.at(-1)?.truncation?.observed, 2001)
        assert.doesNotMatch(JSON.stringify(record), /private metadata|private source|rawOutput/)
    }
    for (const details of [
        null,
        { reason: 'Bearer private reason', limit: 10, observed: 11 },
        { reason: 'line_limit', limit: -1, observed: 11 },
        { reason: 'line_limit', limit: 10, observed: Infinity },
    ]) {
        const record = project(initial(), {
            type: 'tool_completed',
            step: 1,
            result: {
                status: 'success',
                callId: 'read',
                content: '',
                metadata: { truncated: true, truncation: details },
            },
        } as RunEventSnapshot)
        assert.equal(record.feed.at(-1)?.truncated, true)
        assert.equal(record.feed.at(-1)?.truncation, null)
    }
    const ordinary = project(initial(), {
        type: 'tool_completed',
        step: 1,
        result: {
            status: 'success',
            callId: 'ordinary',
            content: '',
            metadata: {
                truncated: false,
                truncation: { reason: 'line_limit', limit: 2000, observed: 2001 },
            },
        },
    })
    assert.equal(ordinary.feed.at(-1)?.truncated, false)
    assert.equal(ordinary.feed.at(-1)?.truncation, null)
})
