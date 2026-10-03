import { z } from 'zod'
import type { SessionState } from './runtime/run.ts'

const settledOutcomeSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('completed'), stopReason: z.literal('final_answer') }),
    z.object({ status: z.literal('failed'), stopReason: z.literal('transport_error') }),
    z.object({
        status: z.literal('aborted'),
        stopReason: z.enum(['aborted', 'step_budget_exhausted']),
    }),
])

export type ChatRunOutcome = Readonly<z.infer<typeof settledOutcomeSchema>>
export type RerunProvenance = Readonly<{
    sourceId: number
    contextPolicy: 'current_conversation'
}>
export type ChatRun = Readonly<{
    id: number
    task: string
    rerun: RerunProvenance | null
}> &
    (
        | Readonly<{ state: 'running'; outcome: null }>
        | Readonly<{ state: 'settled'; outcome: ChatRunOutcome }>
    )
export type ChatRunReservation =
    | Readonly<{ type: 'accepted'; run: ChatRun }>
    | Readonly<{ type: 'duplicate'; run: ChatRun }>
    | Readonly<{
          type: 'rejected'
          reason:
              | 'invalid_source'
              | 'source_unavailable'
              | 'source_unsettled'
              | 'invalid_window'
              | 'run_number_exhausted'
      }>
export type ChatRunSettlement = Readonly<{
    type: 'settled' | 'already_settled' | 'source_unavailable' | 'invalid_outcome'
}>
export type ChatRunCatalog = Readonly<{
    reserveTask: (task: string) => ChatRunReservation
    reserveRerun: (sourceId: number, windowId: number) => ChatRunReservation
    settle: (id: number, outcome: Pick<SessionState, 'status' | 'stopReason'>) => ChatRunSettlement
    get: (id: number) => ChatRun | null
}>
export type ChatRunCatalogOptions = Readonly<{ firstRunId?: number }>

const isRunId = (id: number): boolean => Number.isSafeInteger(id) && id > 0

const snapshot = (run: ChatRun): ChatRun => {
    const rerun = run.rerun === null ? null : Object.freeze({ ...run.rerun })
    if (run.state === 'running') return Object.freeze({ ...run, rerun })
    return Object.freeze({ ...run, rerun, outcome: Object.freeze({ ...run.outcome }) })
}

export const createChatRunCatalog = ({
    firstRunId = 1,
}: ChatRunCatalogOptions = {}): ChatRunCatalog => {
    if (!isRunId(firstRunId))
        throw new RangeError('First run number must be a positive safe integer')
    let nextId: number | null = firstRunId
    const runs = new Map<number, ChatRun>()
    const receipts = new Map<number, Map<number, number>>()
    const reserve = (task: string, rerun: RerunProvenance | null): ChatRunReservation => {
        if (nextId === null) return { type: 'rejected', reason: 'run_number_exhausted' }
        const id = nextId
        nextId = id === Number.MAX_SAFE_INTEGER ? null : id + 1
        const run: ChatRun = { id, task, rerun, state: 'running', outcome: null }
        runs.set(id, run)
        return { type: 'accepted', run: snapshot(run) }
    }

    return {
        reserveTask: (task) => reserve(task, null),
        reserveRerun: (sourceId, windowId) => {
            if (!isRunId(sourceId)) return { type: 'rejected', reason: 'invalid_source' }
            if (!Number.isSafeInteger(windowId) || windowId < 0) {
                return { type: 'rejected', reason: 'invalid_window' }
            }
            const receipt = receipts.get(windowId)?.get(sourceId)
            // Runs and their receipts share the catalog lifetime; a receipt's target is never removed.
            if (receipt !== undefined)
                return { type: 'duplicate', run: snapshot(runs.get(receipt)!) }
            const source = runs.get(sourceId)
            if (source === undefined) return { type: 'rejected', reason: 'source_unavailable' }
            if (source.state !== 'settled') return { type: 'rejected', reason: 'source_unsettled' }
            const reservation = reserve(source.task, {
                sourceId,
                contextPolicy: 'current_conversation',
            })
            if (reservation.type === 'accepted') {
                // Commit both records synchronously; receipts survive settlement and buffered delivery.
                const windowReceipts = receipts.get(windowId) ?? new Map<number, number>()
                windowReceipts.set(sourceId, reservation.run.id)
                receipts.set(windowId, windowReceipts)
            }
            return reservation
        },
        settle: (id, outcome) => {
            const run = runs.get(id)
            if (run === undefined) return { type: 'source_unavailable' }
            if (run.state === 'settled') return { type: 'already_settled' }
            const parsed = settledOutcomeSchema.safeParse(outcome)
            if (!parsed.success) return { type: 'invalid_outcome' }
            // Parsing permits extra session fields but retains only the validated terminal pair.
            runs.set(id, { ...run, state: 'settled', outcome: Object.freeze(parsed.data) })
            return { type: 'settled' }
        },
        get: (id) => {
            const run = runs.get(id)
            return run === undefined ? null : snapshot(run)
        },
    }
}
