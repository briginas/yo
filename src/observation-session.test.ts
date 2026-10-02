import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createObservationSession,
    type ObservationDiagnostic,
    type ObservationView,
} from './observation-session.ts'
import { createRunEventSnapshot } from './runtime/agent-loop.ts'
import type { RunEventSnapshot } from './runtime/run.ts'
import { createTerminalObservationView } from './terminal-observation.ts'
import { createTerminalStatusOutput } from './terminal-renderer.ts'

const started = createRunEventSnapshot({
    type: 'run_started',
    task: 'Task',
    workspaceRoot: '/workspace',
    budget: { maxSteps: 10, perToolTimeoutMs: 5000 },
})
const model = createRunEventSnapshot({
    type: 'model_requested',
    step: 1,
    metadata: { model: null, visibleTools: ['read_file'] },
})
const complete = {
    status: 'completed',
    stopReason: 'final_answer',
    finalAnswer: 'Full answer',
} as const
const emptyView: ObservationView = {
    start: () => undefined,
    event: () => undefined,
    settled: () => undefined,
}

test('reentrant cancellation during header or event writes remains visible while cleanup is held', async () => {
    for (const isInteractive of [true, false]) {
        for (const trigger of ['header', 'event'] as const) {
            const writes: string[] = []
            const diagnostics: ObservationDiagnostic[] = []
            let interrupted = false
            let releaseCleanup!: () => void
            const cleanup = new Promise<void>((resolve) => {
                releaseCleanup = resolve
            })
            const output = createTerminalStatusOutput({
                write: (text) => {
                    writes.push(text)
                    if (
                        !interrupted &&
                        text.includes(trigger === 'header' ? 'Run #1:' : 'model_requested')
                    ) {
                        interrupted = true
                        session.observerFor(1)({ type: 'run_cancellation_requested' })
                        assert.equal(session.getHistory()[0]?.summary.activity, 'cancelling')
                    }
                },
                isInteractive,
                clearLine: () => undefined,
                moveCursorToStart: () => undefined,
            })
            const session = createObservationSession({
                clocks: { wallTime: () => 1000, monotonicTime: () => 100 },
                view: createTerminalObservationView(output, (text) => writes.push(text)),
                onRuntimeEvent: () => undefined,
                diagnose: (diagnostic) => diagnostics.push(diagnostic),
            })
            const run = session.begin('Task')
            if (trigger === 'event') run.onEvent(model)
            const settlement = cleanup.then(() =>
                session.settle(run.id, {
                    status: 'aborted',
                    stopReason: 'aborted',
                    finalAnswer: null,
                })
            )
            await Promise.resolve()
            assert.equal(interrupted, true)
            assert.match(writes.at(-1)!, /cancellation requested/)
            assert.equal(session.getHistory()[0]?.summary.status, 'running')
            assert.equal(session.getHistory()[0]?.result, null)
            const rows = writes.filter((text) => text.startsWith('event:'))
            assert.deepEqual(
                rows.map((text) => /#\d+ ([a-z_]+)/.exec(text)?.[1]),
                trigger === 'header'
                    ? ['run_cancellation_requested']
                    : ['model_requested', 'run_cancellation_requested']
            )
            releaseCleanup()
            await settlement
            assert.match(writes.at(-1)!, /result: cancelled/)
            assert.deepEqual(diagnostics, [])
        }
    }
})

test('reentrant cancellation from runtime observers preserves feed order and latest activity', () => {
    for (const throwAfterRequest of [false, true]) {
        const writes: string[] = []
        const delivered: string[] = []
        const diagnostics: ObservationDiagnostic[] = []
        const output = createTerminalStatusOutput({
            write: (text) => writes.push(text),
            isInteractive: false,
            clearLine: () => undefined,
            moveCursorToStart: () => undefined,
        })
        const session = createObservationSession({
            clocks: { wallTime: () => 1000, monotonicTime: () => 100 },
            view: createTerminalObservationView(output, (text) => writes.push(text)),
            onRuntimeEvent: (event) => {
                delivered.push(event.type)
                if (event.type === 'model_responded') {
                    session.observerFor(1)({ type: 'run_cancellation_requested' })
                    assert.equal(session.getHistory()[0]?.summary.activity, 'cancelling')
                    if (throwAfterRequest) throw new Error('private answer observer')
                }
            },
            diagnose: (diagnostic) => diagnostics.push(diagnostic),
        })
        const run = session.begin('Task')
        assert.doesNotThrow(() =>
            run.onEvent({
                type: 'model_responded',
                step: 1,
                metadata: { model: null, toolCallCount: 0, hasFinalAnswer: true },
            })
        )
        assert.deepEqual(delivered, ['model_responded', 'run_cancellation_requested'])
        assert.deepEqual(
            writes.filter((text) => text.startsWith('event:')),
            [
                'event: run=1 #1 model_responded step=1\n',
                'event: run=1 #2 run_cancellation_requested\n',
            ]
        )
        assert.match(writes.at(-1)!, /cancellation requested/)
        assert.equal(session.getHistory()[0]?.summary.status, 'running')
        assert.equal(session.getHistory()[0]?.result, null)
        assert.deepEqual(diagnostics, throwAfterRequest ? ['observer_failed'] : [])
    }
})

test('saves record and prepares identity-bound observer before synchronous runtime events', () => {
    let elapsed = 100
    const messages: string[] = []
    const diagnostics: ObservationDiagnostic[] = []
    const session = createObservationSession({
        clocks: { wallTime: () => 1000, monotonicTime: () => elapsed },
        view: {
            ...emptyView,
            event: (record, row) => messages.push(`${record.summary.id}:${row?.type}`),
        },
        onRuntimeEvent: () => undefined,
        diagnose: (diagnostic) => diagnostics.push(diagnostic),
    })
    const first = session.begin('First')
    assert.equal(session.getHistory()[0]?.summary.id, first.id)
    const runtime = (onEvent: (event: RunEventSnapshot) => void) => {
        onEvent(started)
        onEvent(model)
        assert.deepEqual(messages, ['1:run_started', '1:model_requested'])
    }
    runtime(first.onEvent)
    assert.equal(Object.isFrozen(model), true)
    assert.equal(session.getHistory()[0]?.summary.activity, 'model')
    elapsed = 150
    first.onEvent(
        createRunEventSnapshot({
            type: 'run_finished',
            status: 'completed',
            reason: 'final_answer',
        })
    )
    assert.equal(session.getHistory()[0]?.summary.status, 'running')
    session.settle(first.id, complete)
    const settled = session.getHistory()[0]
    const second = session.begin('Second')
    assert.equal(second.id, 2)
    first.onEvent(model)
    session.settle(first.id, { status: 'failed', stopReason: 'transport_error', finalAnswer: null })
    assert.equal(session.getHistory()[0], settled)
    assert.equal(session.getHistory()[0]?.summary.elapsedMs, 50)
    assert.equal(session.getHistory()[1]?.feed.length, 0)
    assert.deepEqual(diagnostics, [])
})

test('diagnoses absent records while treating settled records as ordinary late guards', () => {
    const diagnostics: ObservationDiagnostic[] = []
    let observerCalls = 0
    const session = createObservationSession({
        clocks: { wallTime: () => 0, monotonicTime: () => 0 },
        view: emptyView,
        onRuntimeEvent: () => {
            observerCalls++
        },
        diagnose: (value) => diagnostics.push(value),
    })
    const run = session.begin('Task')
    session.observerFor(999)(model)
    session.settle(999, complete)
    session.fail(999)
    assert.deepEqual(diagnostics, ['missing_record', 'missing_record', 'missing_record'])
    assert.equal(observerCalls, 0)
    session.settle(run.id, complete)
    run.onEvent(model)
    session.fail(run.id)
    assert.equal(diagnostics.length, 3)
    assert.equal(observerCalls, 0)
})

test('isolates projection, answer observer, display, and diagnostic failures independently', () => {
    for (const failure of ['projection', 'observer', 'display', 'diagnostic'] as const) {
        const diagnostics: ObservationDiagnostic[] = []
        let answerEvents = 0
        let displayEvents = 0
        const session = createObservationSession({
            clocks: { wallTime: () => 1000, monotonicTime: () => 100 },
            view: {
                ...emptyView,
                event: () => {
                    displayEvents++
                    if (failure === 'display') throw new Error('Bearer private display failure')
                },
            },
            onRuntimeEvent: () => {
                answerEvents++
                if (failure === 'observer') throw new Error('private observer failure')
            },
            diagnose: (value) => {
                diagnostics.push(value)
                if (failure === 'diagnostic') throw new Error('private diagnostic failure')
            },
            ...(failure === 'projection' || failure === 'diagnostic'
                ? {
                      projectEvent: () => {
                          throw new Error('private projection failure')
                      },
                  }
                : {}),
        })
        const run = session.begin('Task')
        assert.doesNotThrow(() => run.onEvent(model))
        assert.equal(answerEvents, 1)
        assert.equal(displayEvents, failure === 'projection' || failure === 'diagnostic' ? 0 : 1)
        session.settle(run.id, complete)
        assert.equal(session.getHistory()[0]?.summary.status, 'completed')
        assert.deepEqual(diagnostics, [
            failure === 'observer'
                ? 'observer_failed'
                : failure === 'display'
                  ? 'rendering_failed'
                  : 'projection_failed',
        ])
    }
})

test('start and settled rendering failures do not lose records or prevent finalization', () => {
    const diagnostics: ObservationDiagnostic[] = []
    const session = createObservationSession({
        clocks: { wallTime: () => 1000, monotonicTime: () => 0 },
        view: {
            ...emptyView,
            start: () => {
                throw new Error('private')
            },
            settled: () => {
                throw new Error('private')
            },
        },
        onRuntimeEvent: () => undefined,
        diagnose: (value) => diagnostics.push(value),
    })
    const run = session.begin('Task')
    assert.equal(session.getHistory().length, 1)
    session.settle(run.id, complete)
    assert.equal(session.getHistory()[0]?.result?.outcome, 'completed')
    assert.deepEqual(diagnostics, ['rendering_failed', 'rendering_failed'])
})

test('unexpected CLI turn failure settles partial evidence without inventing transport errors', () => {
    let time = 5
    const session = createObservationSession({
        clocks: { wallTime: () => 1000, monotonicTime: () => time },
        view: emptyView,
        onRuntimeEvent: () => undefined,
        diagnose: () => undefined,
    })
    const run = session.begin('Task')
    run.onEvent(model)
    time = 15
    session.fail(run.id)
    const record = session.getHistory()[0]!
    assert.equal(record.summary.status, 'failed')
    assert.equal(record.summary.stopReason, 'cli_turn_error')
    assert.equal(record.result?.errors[0]?.reason, 'cli_turn_error')
    assert.equal(record.feed.length, 1)
    assert.equal(record.summary.elapsedMs, 10)
    assert.equal(record.result?.answer, null)
    run.onEvent(model)
    assert.equal(session.getHistory()[0], record)
})

test('clock failure uses the last sampled time and does not prevent settlement', () => {
    let fail = false
    const diagnostics: ObservationDiagnostic[] = []
    const session = createObservationSession({
        clocks: {
            wallTime: () => 1000,
            monotonicTime: () => {
                if (fail) throw new Error('private clock')
                return 10
            },
        },
        view: emptyView,
        onRuntimeEvent: () => undefined,
        diagnose: (value) => diagnostics.push(value),
    })
    const run = session.begin('Task')
    fail = true
    run.onEvent(model)
    session.settle(run.id, complete)
    assert.equal(session.getHistory()[0]?.summary.elapsedMs, 0)
    assert.equal(session.getHistory()[0]?.summary.status, 'completed')
    assert.deepEqual(diagnostics, ['clock_failed', 'clock_failed'])
})

test('initial clock failure still creates the record before runtime and marks timing unavailable', () => {
    const session = createObservationSession({
        clocks: {
            wallTime: () => {
                throw new Error('clock')
            },
            monotonicTime: () => 0,
        },
        view: emptyView,
        onRuntimeEvent: () => undefined,
        diagnose: () => undefined,
    })
    const run = session.begin('Task')
    assert.equal(session.getHistory()[0]?.timingAvailable, false)
    run.onEvent(started)
    session.settle(run.id, complete)
    assert.equal(session.getHistory()[0]?.summary.status, 'completed')
    assert.equal(session.getHistory()[0]?.timingAvailable, false)
})

test('cancellation settlement and next-run identity survive observation and clock failures', () => {
    for (const failure of ['projection', 'observer', 'display', 'clock', 'diagnostic'] as const) {
        let time = 100
        let failClock = false
        const delivered: RunEventSnapshot[] = []
        const diagnostics: ObservationDiagnostic[] = []
        const session = createObservationSession({
            clocks: {
                wallTime: () => 1000,
                monotonicTime: () => {
                    if (failClock) throw new Error('private clock')
                    return time
                },
            },
            view: {
                ...emptyView,
                event: () => {
                    if (failure === 'display') throw new Error('private display')
                },
                settled: () => {
                    if (failure === 'display') throw new Error('private settled display')
                },
            },
            onRuntimeEvent: (event) => {
                delivered.push(event)
                if (failure === 'observer') throw new Error('private observer')
            },
            diagnose: (diagnostic) => {
                diagnostics.push(diagnostic)
                if (failure === 'diagnostic') throw new Error('private diagnostic')
            },
            ...(failure === 'projection' || failure === 'diagnostic'
                ? {
                      projectEvent: () => {
                          throw new Error('private projection')
                      },
                  }
                : {}),
        })
        const run = session.begin('Cancelled task')
        failClock = failure === 'clock'
        assert.doesNotThrow(() => run.onEvent({ type: 'run_cancellation_requested' }))
        assert.deepEqual(delivered, [{ type: 'run_cancellation_requested' }])
        assert.equal(session.getHistory()[0]?.summary.status, 'running')
        time = 150
        assert.doesNotThrow(() =>
            session.settle(run.id, {
                status: 'aborted',
                stopReason: 'aborted',
                finalAnswer: null,
            })
        )
        const settled = session.getHistory()[0]!
        const before = structuredClone(settled)
        assert.equal(settled.result?.outcome, 'aborted')
        assert.equal(settled.result?.stopReason, 'aborted')
        assert.equal(settled.timingAvailable, failure !== 'clock')
        assert.equal(settled.summary.elapsedMs, failure === 'clock' ? 0 : 50)
        const second = session.begin('Fresh task')
        assert.equal(second.id, 2)
        run.onEvent({ type: 'run_cancellation_requested' })
        run.onEvent(model)
        session.settle(run.id, complete)
        assert.equal(session.getHistory()[0], settled)
        assert.deepEqual(settled, before)
        assert.equal(session.getHistory()[1]?.feed.length, 0)
        assert.equal(delivered.length, 1)
        assert.ok(diagnostics.length > 0)
    }
})
