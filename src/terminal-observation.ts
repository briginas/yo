import type { ObservationDiagnostic, ObservationView } from './observation-session.ts'
import type { FeedRow, ObservationHistory, RunRecord } from './run-observation.ts'
import type { TerminalStatusOutput, TerminalTextWriter } from './terminal-renderer.ts'

const duration = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(3)}s`
const localTime = (milliseconds: number): string => {
    const date = new Date(milliseconds)
    return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':')
}
const elapsedLabel = (record: RunRecord): string =>
    record.timingAvailable ? duration(record.summary.elapsedMs) : 'unavailable'
const startLabel = (record: RunRecord): string =>
    record.timingAvailable ? localTime(record.summary.startedAtMs) : 'unavailable'
const callNumber = (record: RunRecord, step: number | null, callId: string | null): string => {
    if (callId === null) return ''
    const index = record.calls.findIndex((call) => call.step === step && call.callId === callId)
    return index < 0 ? ' call=unavailable' : ` call=${index + 1}`
}
export const formatObservationFeedRow = (record: RunRecord, row: FeedRow): string =>
    [
        `event: run=${row.runId} #${row.sequence} ${row.type}`,
        row.step === null ? '' : ` step=${row.step}`,
        callNumber(record, row.step, row.callId),
        row.tool === null ? '' : ` tool=${row.tool}`,
        row.outcome === null ? '' : ` outcome=${row.outcome}`,
        !row.truncated ? '' : ' truncated=true',
        !row.truncated || row.truncation === null
            ? ''
            : ` reason=${row.truncation.reason} limit=${row.truncation.limit} observed=${row.truncation.observed}`,
    ].join('')

export const formatObservationState = (record: RunRecord): string =>
    `state: run=${record.summary.id} ${record.summary.activity ?? record.summary.status} elapsed=${elapsedLabel(record)}`

export const formatObservationResult = (record: RunRecord, history: ObservationHistory): string => {
    const result = record.result
    if (result === null) return ''
    const errors = result.errors.map(
        (error) =>
            `- ${error.reason}${error.step === null ? '' : ` step=${error.step}`}${callNumber(record, error.step, error.callId)}`
    )
    const patches = result.approvals.map((approval) => {
        const states = record.feed
            .filter(
                (row) =>
                    row.type.startsWith('patch_') &&
                    row.step === approval.step &&
                    row.callId === approval.callId
            )
            .map((row) => row.outcome)
        return `- ${approval.path}: ${states.join(' -> ')}${approval.conflict === null ? '' : ` (${approval.conflict})`}`
    })
    return [
        `Run #${record.summary.id} result: ${result.outcome}`,
        `Elapsed: ${elapsedLabel(record)}`,
        'Evidence:',
        `Stop reason: ${result.stopReason}`,
        `Tools: ${result.tools.length === 0 ? '(none)' : result.tools.join(', ')}`,
        'Files:',
        ...(result.files.length === 0 ? ['- (none)'] : result.files.map((file) => `- ${file}`)),
        'Errors:',
        ...(errors.length === 0 ? ['- (none)'] : errors),
        'Patches:',
        ...(patches.length === 0 ? ['- (none)'] : patches),
        'Session runs:',
        ...history.map(
            (item) =>
                `- #${item.summary.id} ${item.summary.taskPreview} | ${item.summary.status} | start=${startLabel(item)} elapsed=${elapsedLabel(item)}`
        ),
    ].join('\n')
}

export const formatObservationDiagnostic = (diagnostic: ObservationDiagnostic): string => {
    switch (diagnostic) {
        case 'missing_record':
            return 'Observation: run record is missing.'
        case 'projection_failed':
            return 'Observation: event projection failed.'
        case 'observer_failed':
            return 'Observation: answer observer failed.'
        case 'rendering_failed':
            return 'Observation: display failed.'
        case 'clock_failed':
            return 'Observation: timing sample unavailable.'
    }
}

export const createTerminalObservationView = (
    output: TerminalStatusOutput,
    writeOutput: TerminalTextWriter
): ObservationView => ({
    start: (record) => {
        output.writeLine(
            `Run #${record.summary.id}: ${record.summary.taskPreview} | start=${startLabel(record)}`
        )
        output.writeProgress(formatObservationState(record))
    },
    event: (record, row) => {
        if (row === null) return
        output.writeLine(formatObservationFeedRow(record, row))
        output.writeProgress(formatObservationState(record))
    },
    settled: (record, history) => {
        output.clearProgress()
        writeOutput(formatObservationResult(record, history))
    },
})
