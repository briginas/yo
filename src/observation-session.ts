import {
    createRunRecord,
    failRunRecord,
    finalizeRunRecord,
    projectRunEvent,
    type ClockSample,
    type FeedRow,
    type ObservationHistory,
    type RunIdentity,
    type RunRecord,
    type SettledSession,
} from './run-observation.ts'
import type { RunEventObserver } from './runtime/run.ts'

export type ObservationClocks = Readonly<{
    wallTime: () => number
    monotonicTime: () => number
}>
export type ObservationDiagnostic =
    'missing_record' | 'projection_failed' | 'observer_failed' | 'rendering_failed' | 'clock_failed'
export type ObservationView = Readonly<{
    start: (record: RunRecord) => void
    event: (record: RunRecord, row: FeedRow | null) => void
    settled: (record: RunRecord, history: ObservationHistory) => void
}>
export type ObservationSessionOptions = Readonly<{
    clocks: ObservationClocks
    view: ObservationView
    onRuntimeEvent: RunEventObserver
    diagnose: (diagnostic: ObservationDiagnostic) => void
    projectEvent?: typeof projectRunEvent
}>
export type ObservationSession = Readonly<{
    begin: (task: string) => Readonly<{ id: RunIdentity; onEvent: RunEventObserver }>
    observerFor: (id: RunIdentity) => RunEventObserver
    settle: (id: RunIdentity, session: SettledSession, beforeResult?: () => void) => void
    fail: (id: RunIdentity) => void
    getHistory: () => ObservationHistory
}>

export const createObservationSession = ({
    clocks,
    view,
    onRuntimeEvent,
    diagnose,
    projectEvent = projectRunEvent,
}: ObservationSessionOptions): ObservationSession => {
    let history: ObservationHistory = []
    let nextId = 1
    let lastSample: ClockSample = { wallTimeMs: 0, monotonicTimeMs: 0 }
    const report = (diagnostic: ObservationDiagnostic): void => {
        try {
            diagnose(diagnostic)
        } catch {
            // Diagnostic output is a non-owning observer too.
        }
    }
    const isolated = (action: () => void, diagnostic: ObservationDiagnostic): void => {
        try {
            action()
        } catch {
            report(diagnostic)
        }
    }
    const pendingNotifications: (() => void)[] = []
    let notifying = false
    const notify = (action: () => void): void => {
        pendingNotifications.push(action)
        if (notifying) return
        notifying = true
        try {
            // A consumer can request cancellation synchronously. Save it immediately, but finish
            // this event's notifications before the nested event to preserve feed and display order.
            while (pendingNotifications.length > 0) pendingNotifications.shift()!()
        } finally {
            notifying = false
        }
    }
    const sample = (): Readonly<{ value: ClockSample; available: boolean }> => {
        try {
            const value = { wallTimeMs: clocks.wallTime(), monotonicTimeMs: clocks.monotonicTime() }
            if (!Number.isFinite(value.wallTimeMs) || !Number.isFinite(value.monotonicTimeMs)) {
                throw new Error('Invalid clock sample')
            }
            lastSample = value
            return { value, available: true }
        } catch {
            report('clock_failed')
        }
        return { value: lastSample, available: false }
    }
    const active = (id: RunIdentity): RunRecord | null => {
        const record = history.find((item) => item.summary.id === id)
        if (record === undefined) {
            report('missing_record')
            return null
        }
        return record.summary.status === 'running' ? record : null
    }
    const save = (record: RunRecord): void => {
        history = history.map((item) => (item.summary.id === record.summary.id ? record : item))
    }
    const observerFor =
        (id: RunIdentity): RunEventObserver =>
        (event) => {
            const record = active(id)
            if (record === null) return
            const projection: { record: RunRecord | null } = { record: null }
            isolated(() => {
                const time = sample()
                const next = projectEvent(record, id, event, time.value)
                projection.record = {
                    ...next,
                    timingAvailable: record.timingAvailable && time.available,
                }
                save(projection.record)
            }, 'projection_failed')
            notify(() => {
                // The answer observer still receives the snapshot if projection or rendering fails.
                isolated(() => onRuntimeEvent(event), 'observer_failed')
                const projected = projection.record
                if (projected !== null) {
                    const row =
                        projected.feed.length > record.feed.length ? projected.feed.at(-1)! : null
                    isolated(() => view.event(projected, row), 'rendering_failed')
                }
            })
        }
    const finish = (
        id: RunIdentity,
        session: SettledSession | null,
        beforeResult?: () => void
    ): void => {
        const record = active(id)
        if (record === null) {
            if (!history.some((item) => item.summary.id === id) && beforeResult !== undefined) {
                isolated(beforeResult, 'observer_failed')
            }
            return
        }
        const time = sample()
        const next =
            session === null
                ? failRunRecord(record, id, time.value)
                : finalizeRunRecord(record, id, session, time.value)
        const timed = { ...next, timingAvailable: record.timingAvailable && time.available }
        save(timed)
        if (timed.summary.status !== 'running') {
            if (beforeResult !== undefined) isolated(beforeResult, 'observer_failed')
            notify(() => isolated(() => view.settled(timed, history), 'rendering_failed'))
        }
    }
    return {
        begin: (task) => {
            const id = nextId++
            const time = sample()
            const record = {
                ...createRunRecord(id, task, time.value),
                timingAvailable: time.available,
            }
            history = [...history, record]
            const onEvent = observerFor(id)
            notify(() => isolated(() => view.start(record), 'rendering_failed'))
            return { id, onEvent }
        },
        observerFor,
        settle: (id, session, beforeResult) => finish(id, session, beforeResult),
        fail: (id) => finish(id, null),
        getHistory: () => history,
    }
}
