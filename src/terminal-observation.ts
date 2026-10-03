import type { ObservationDiagnostic, ObservationView } from './observation-session.ts'
import type { FeedRow, ObservationHistory, RunRecord } from './run-observation.ts'
import type { TerminalStatusOutput, TerminalTextWriter } from './terminal-renderer.ts'
import type { ObservationCommand } from './observation-command.ts'
import { plainTerminalText, type TerminalTextFormatter } from './terminal-style.ts'

export const OBSERVATION_USAGE = 'Inspect: /run N | List: /runs | Rerun: /rerun N'

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
const outcomeLabel = (record: RunRecord): string =>
    record.summary.status === 'aborted' && record.summary.stopReason === 'aborted'
        ? 'cancelled'
        : record.summary.status
const rerunLabels = (record: RunRecord): string[] =>
    record.rerun === null
        ? []
        : [`Rerun of #${record.rerun.sourceId}`, 'Context: current conversation']
const formatHeader = (record: RunRecord): string =>
    [
        `Run #${record.summary.id}: ${record.summary.taskPreview} | start=${startLabel(record)}`,
        ...rerunLabels(record),
    ].join(' | ')
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

export const formatObservationState = (record: RunRecord): string => {
    const activity = record.summary.activity
    return `state: run=${record.summary.id} ${activity === 'cancelling' ? 'cancellation requested' : (activity ?? outcomeLabel(record))} elapsed=${elapsedLabel(record)}`
}

const formatResultCard = (record: RunRecord): string => {
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
        `Run #${record.summary.id} result: ${outcomeLabel(record)}`,
        ...rerunLabels(record),
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
    ].join('\n')
}

export const formatObservationList = (history: ObservationHistory): string =>
    [
        'Session runs:',
        ...(history.length === 0
            ? ['No runs yet.']
            : history.map((item) =>
                  [
                      `- #${item.summary.id} ${item.summary.taskPreview} | ${outcomeLabel(item)} | start=${startLabel(item)} elapsed=${elapsedLabel(item)} | reason=${item.summary.stopReason ?? 'pending'}`,
                      ...rerunLabels(item),
                  ].join(' | ')
              )),
        OBSERVATION_USAGE,
    ].join('\n')

export const formatObservationResult = (record: RunRecord, history: ObservationHistory): string =>
    record.result === null ? '' : `${formatResultCard(record)}\n${formatObservationList(history)}`

export const formatObservationInspection = (
    history: ObservationHistory,
    id: number,
    formatTechnical: TerminalTextFormatter = plainTerminalText
): string => {
    const record = history.find((item) => item.summary.id === id)
    if (record === undefined)
        return formatTechnical(`Run #${id} is unavailable.\n${OBSERVATION_USAGE}`)
    if (record.summary.status === 'running' || record.result === null) {
        return formatTechnical(`Run #${id} is not settled.\n${OBSERVATION_USAGE}`)
    }
    return [
        formatTechnical(
            [
                formatHeader(record),
                'Events:',
                ...(record.feed.length === 0
                    ? ['(none)']
                    : record.feed.map((row) => formatObservationFeedRow(record, row))),
                'Retained answer:',
            ].join('\n')
        ),
        record.result.answer ?? formatTechnical('(no final answer)'),
        formatTechnical(
            [
                ...(record.result.answerTruncated ? ['[Answer preview truncated]'] : []),
                formatResultCard(record),
            ].join('\n')
        ),
    ].join('\n')
}

export const formatObservationCommand = (
    command: Exclude<ObservationCommand, { type: 'message' }>,
    history: ObservationHistory,
    formatTechnical: TerminalTextFormatter = plainTerminalText
): string => {
    switch (command.type) {
        case 'list':
            return formatTechnical(formatObservationList(history))
        case 'inspect':
            return formatObservationInspection(history, command.id, formatTechnical)
        case 'invalid':
            return formatTechnical('Usage: /runs or /run N (positive run number).')
    }
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
        output.writeLine(formatHeader(record))
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
