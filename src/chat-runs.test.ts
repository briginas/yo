import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createChatRunCatalog,
    type ChatRun,
    type ChatRunOutcome,
    type ChatRunReservation,
} from './chat-runs.ts'

const completed = { status: 'completed', stopReason: 'final_answer' } as const
const accepted = (reservation: ChatRunReservation): ChatRun => {
    assert.equal(reservation.type, 'accepted')
    if (reservation.type !== 'accepted') throw new Error('Expected accepted reservation')
    return reservation.run
}

test('allocates ordinary tasks once in order and keeps catalogs session-local', () => {
    const catalog = createChatRunCatalog()
    assert.equal(catalog.get(1), null)
    const first = accepted(catalog.reserveTask(' Inspect '))
    const second = accepted(catalog.reserveTask(' Inspect '))
    assert.deepEqual(first, {
        id: 1,
        task: ' Inspect ',
        rerun: null,
        state: 'running',
        outcome: null,
    })
    assert.equal(second.id, 2)
    assert.equal(second.task, first.task)
    assert.equal(accepted(createChatRunCatalog().reserveTask('Other session')).id, 1)
    assert.deepEqual(catalog.get(1), first)
})

test('requires a known settled source without consuming a number on rejection', () => {
    const catalog = createChatRunCatalog()
    assert.deepEqual(catalog.reserveRerun(1, 0), { type: 'rejected', reason: 'source_unavailable' })
    const first = accepted(catalog.reserveTask('Inspect'))
    assert.deepEqual(catalog.reserveRerun(first.id, 0), {
        type: 'rejected',
        reason: 'source_unsettled',
    })
    assert.deepEqual(catalog.settle(99, completed), { type: 'source_unavailable' })
    for (const id of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        assert.deepEqual(catalog.reserveRerun(id, 0), {
            type: 'rejected',
            reason: 'invalid_source',
        })
        assert.equal(catalog.get(id), null)
    }
    assert.equal(accepted(catalog.reserveTask('Next task')).id, 2)
})

test('each valid terminal outcome permits a rerun with a direct source link', () => {
    const outcomes: ChatRunOutcome[] = [
        completed,
        { status: 'failed', stopReason: 'transport_error' },
        { status: 'aborted', stopReason: 'aborted' },
        { status: 'aborted', stopReason: 'step_budget_exhausted' },
    ]
    for (const outcome of outcomes) {
        const catalog = createChatRunCatalog()
        const source = accepted(catalog.reserveTask('Inspect'))
        assert.deepEqual(catalog.settle(source.id, outcome), { type: 'settled' })
        const before = catalog.get(source.id)
        const rerun = accepted(catalog.reserveRerun(source.id, 0))
        assert.deepEqual(rerun, {
            id: 2,
            task: 'Inspect',
            rerun: { sourceId: 1, contextPolicy: 'current_conversation' },
            state: 'running',
            outcome: null,
        })
        assert.deepEqual(catalog.get(source.id), before)
        assert.deepEqual(catalog.settle(rerun.id, completed), { type: 'settled' })
        assert.deepEqual(catalog.get(source.id), before)
    }
})

test('retains exact long tasks and links a rerun to its directly selected attempt', () => {
    const catalog = createChatRunCatalog()
    const task = ` \tInspect 🧩\n${'Юникод '.repeat(100)}access_token fixture text\t `
    const source = accepted(catalog.reserveTask(task))
    catalog.settle(source.id, completed)
    const second = accepted(catalog.reserveRerun(source.id, 0))
    catalog.settle(second.id, { status: 'aborted', stopReason: 'aborted' })
    const third = accepted(catalog.reserveRerun(second.id, 1))
    assert.equal(second.task, task)
    assert.equal(third.task, task)
    assert.deepEqual(third.rerun, { sourceId: 2, contextPolicy: 'current_conversation' })
    assert.deepEqual(catalog.get(2)?.rerun, { sourceId: 1, contextPolicy: 'current_conversation' })
    assert.equal(catalog.get(1)?.rerun, null)
})

test('returns detached frozen snapshots that cannot rewrite identity, task, outcome, or linkage', () => {
    const catalog = createChatRunCatalog()
    const source = accepted(catalog.reserveTask('Original task'))
    assert.equal(Reflect.set(source, 'task', 'Changed task'), false)
    assert.equal(Reflect.set(source, 'id', 99), false)
    assert.deepEqual(catalog.get(1), source)
    assert.notEqual(catalog.get(1), source)
    catalog.settle(1, completed)
    assert.equal(source.state, 'running')
    const settled = catalog.get(1)!
    assert.equal(Reflect.set(settled.outcome!, 'status', 'failed'), false)
    const rerun = accepted(catalog.reserveRerun(1, 0))
    assert.equal(Reflect.set(rerun.rerun!, 'sourceId', 99), false)
    assert.equal(Reflect.set(rerun.rerun!, 'contextPolicy', 'original_snapshot'), false)
    assert.notEqual(catalog.get(2)?.rerun, rerun.rerun)
    assert.notEqual(catalog.get(1)?.outcome, settled.outcome)
    assert.equal(catalog.get(1)?.task, 'Original task')
    assert.deepEqual(catalog.get(2)?.rerun, { sourceId: 1, contextPolicy: 'current_conversation' })
})

test('validates terminal status/reason pairs and settles at most once', () => {
    const catalog = createChatRunCatalog()
    catalog.reserveTask('Inspect')
    for (const outcome of [
        { status: 'pending', stopReason: null },
        { status: 'running', stopReason: null },
        { status: 'completed', stopReason: 'aborted' },
        { status: 'failed', stopReason: 'final_answer' },
        { status: 'aborted', stopReason: 'transport_error' },
    ] as const) {
        assert.deepEqual(catalog.settle(1, outcome), { type: 'invalid_outcome' })
        assert.equal(catalog.get(1)?.state, 'running')
    }
    const outcome = { ...completed, task: 'private session task', finalAnswer: 'not stored' }
    assert.deepEqual(catalog.settle(1, outcome), { type: 'settled' })
    const before = catalog.get(1)
    assert.deepEqual(before?.outcome, completed)
    assert.deepEqual(catalog.settle(1, { status: 'failed', stopReason: 'transport_error' }), {
        type: 'already_settled',
    })
    assert.deepEqual(catalog.get(1), before)
})

test('allocates the maximum safe number once and rejects exhaustion without corrupting sources', () => {
    const catalog = createChatRunCatalog({ firstRunId: Number.MAX_SAFE_INTEGER - 1 })
    const source = accepted(catalog.reserveTask('Inspect'))
    catalog.settle(source.id, completed)
    const last = accepted(catalog.reserveRerun(source.id, 0))
    assert.equal(last.id, Number.MAX_SAFE_INTEGER)
    const before = catalog.get(source.id)
    assert.deepEqual(catalog.reserveTask('Overflow'), {
        type: 'rejected',
        reason: 'run_number_exhausted',
    })
    assert.deepEqual(catalog.reserveRerun(source.id, 1), {
        type: 'rejected',
        reason: 'run_number_exhausted',
    })
    assert.deepEqual(catalog.get(source.id), before)
    assert.deepEqual(catalog.get(last.id), last)
    for (const firstRunId of [
        0,
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        assert.throws(() => createChatRunCatalog({ firstRunId }), RangeError)
    }
})

test('one action retains its accepted attempt during work and after settlement', () => {
    const catalog = createChatRunCatalog()
    catalog.reserveTask('Inspect')
    catalog.settle(1, completed)
    const before = catalog.get(1)
    const rerun = accepted(catalog.reserveRerun(1, 0))
    const pendingDuplicate = catalog.reserveRerun(1, 0)
    assert.deepEqual(pendingDuplicate, { type: 'duplicate', run: rerun })
    if (pendingDuplicate.type !== 'duplicate') throw new Error('Expected duplicate')
    assert.notEqual(pendingDuplicate.run, rerun)
    assert.equal(Reflect.set(pendingDuplicate.run.rerun!, 'sourceId', 99), false)
    assert.deepEqual(catalog.settle(rerun.id, { status: 'aborted', stopReason: 'aborted' }), {
        type: 'settled',
    })
    assert.deepEqual(catalog.reserveRerun(1, 0), { type: 'duplicate', run: catalog.get(rerun.id) })
    assert.deepEqual(catalog.get(1), before)
    assert.equal(accepted(catalog.reserveTask('Next task')).id, 3)
})

test('fresh windows permit later attempts and different sources are different actions', () => {
    const catalog = createChatRunCatalog()
    catalog.reserveTask('Same task')
    catalog.reserveTask('Same task')
    catalog.settle(1, completed)
    catalog.settle(2, completed)
    const first = accepted(catalog.reserveRerun(1, 7))
    catalog.settle(first.id, completed)
    const later = accepted(catalog.reserveRerun(1, 8))
    const differentSource = accepted(catalog.reserveRerun(2, 8))
    assert.equal(first.id, 3)
    assert.equal(later.id, 4)
    assert.equal(differentSource.id, 5)
    assert.deepEqual(differentSource.rerun, { sourceId: 2, contextPolicy: 'current_conversation' })
    assert.deepEqual(catalog.reserveRerun(1, 7), { type: 'duplicate', run: catalog.get(first.id) })
    assert.deepEqual(catalog.reserveRerun(1, 8), { type: 'duplicate', run: later })
    assert.equal(accepted(catalog.reserveTask('Same task')).id, 6)
})

test('invalid identities and unavailable sources consume no action receipt or run number', () => {
    const catalog = createChatRunCatalog()
    catalog.reserveTask('Inspect')
    for (const windowId of [
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
    ]) {
        assert.deepEqual(catalog.reserveRerun(1, windowId), {
            type: 'rejected',
            reason: 'invalid_window',
        })
    }
    assert.deepEqual(catalog.reserveRerun(1, 4), { type: 'rejected', reason: 'source_unsettled' })
    assert.deepEqual(catalog.reserveRerun(2, 4), { type: 'rejected', reason: 'source_unavailable' })
    catalog.settle(1, completed)
    const second = accepted(catalog.reserveRerun(1, 4))
    assert.equal(second.id, 2)
    catalog.settle(second.id, completed)
    const third = accepted(catalog.reserveRerun(2, 4))
    assert.equal(third.id, 3)
    assert.equal(accepted(catalog.reserveRerun(1, Number.MAX_SAFE_INTEGER)).id, 4)
})

test('receipts remain valid when the allocator is exhausted', () => {
    const catalog = createChatRunCatalog({ firstRunId: Number.MAX_SAFE_INTEGER - 1 })
    const source = accepted(catalog.reserveTask('Inspect'))
    catalog.settle(source.id, completed)
    const last = accepted(catalog.reserveRerun(source.id, 0))
    assert.deepEqual(catalog.reserveRerun(source.id, 1), {
        type: 'rejected',
        reason: 'run_number_exhausted',
    })
    assert.deepEqual(catalog.reserveRerun(source.id, 0), { type: 'duplicate', run: last })
    catalog.settle(last.id, completed)
    assert.deepEqual(catalog.reserveRerun(source.id, 0), {
        type: 'duplicate',
        run: catalog.get(last.id),
    })
})
