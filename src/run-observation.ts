import { normalize, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { RunEventSnapshot, SessionState, StopReason } from './runtime/run.ts'
import type { PatchApprovalDecision, PatchConflict } from './runtime/patch-contracts.ts'
import {
    readFileArgumentsSchema,
    type ToolName,
    type ToolResultStatus,
    type ToolResultTruncation,
} from './runtime/tools.ts'

export type RunIdentity = number
export type ClockSample = Readonly<{ wallTimeMs: number; monotonicTimeMs: number }>
export type ObservationStopReason = StopReason | 'cli_turn_error'
export type RunOutcome = 'completed' | 'failed' | 'aborted' | 'budget_exhausted'
export type RunActivity = 'starting' | 'model' | 'tools' | 'approval' | 'finishing' | 'cancelling'
export type ApprovalState = 'prepared' | 'waiting' | PatchApprovalDecision | 'conflict' | 'applied'
export type ApprovalSummary = Readonly<{
    step: number
    callId: string
    path: string
    state: ApprovalState
    conflict: PatchConflict['code'] | null
}>
export type FeedRow = Readonly<{
    truncated: boolean
    truncation: Readonly<ToolResultTruncation> | null
    sequence: number
    runId: RunIdentity
    type: Exclude<RunEventSnapshot['type'], 'final_answer' | 'final_answer_delta'>
    step: number | null
    callId: string | null
    tool: ToolName | 'unknown_tool' | null
    outcome: ToolResultStatus | 'allow' | 'deny' | ApprovalState | StopReason | null
}>
export type ObservationError = Readonly<{
    step: number | null
    callId: string | null
    reason: Exclude<ToolResultStatus, 'success'> | 'transport_error' | 'cli_turn_error'
}>
export type ResultCard = Readonly<{
    outcome: RunOutcome
    stopReason: ObservationStopReason
    answer: string | null
    answerTruncated: boolean
    tools: readonly (ToolName | 'unknown_tool')[]
    files: readonly string[]
    errors: readonly ObservationError[]
    approvals: readonly ApprovalSummary[]
}>
export type RunSummary = Readonly<{
    id: RunIdentity
    taskPreview: string
    startedAtMs: number
    elapsedMs: number
}> &
    (
        | Readonly<{ status: 'running'; activity: RunActivity; stopReason: null }>
        | Readonly<{ status: RunOutcome; activity: null; stopReason: ObservationStopReason }>
    )
type CallSummary = Readonly<{
    step: number
    callId: string
    tool: ToolName | 'unknown_tool'
    readPath: string | null
}>
export type RunRecord = Readonly<{
    summary: RunSummary
    // False means fallback numeric clock values must not be presented as measured time.
    timingAvailable: boolean
    workspaceRoot: string | null
    startedMonotonicMs: number
    feed: readonly FeedRow[]
    calls: readonly CallSummary[]
    tools: readonly (ToolName | 'unknown_tool')[]
    files: readonly string[]
    errors: readonly ObservationError[]
    approvals: readonly ApprovalSummary[]
    result: ResultCard | null
}>
export type ObservationHistory = readonly RunRecord[]
export type SettledSession = Pick<SessionState, 'status' | 'stopReason' | 'finalAnswer'>

const truncationSchema = z
    .object({
        reason: z.enum(['byte_limit', 'line_limit', 'result_limit']),
        limit: z.number().int().nonnegative(),
        observed: z.number().int().nonnegative(),
    })
    .loose()

const PREVIEW_CHARACTERS = 160
const EVIDENCE_ITEMS = 200
const ANSWER_CHARACTERS = 16_000
const sensitive = /(?:authorization|bearer|access_token|refresh_token|client_secret|sk-)/i

// Display data is deliberately lossy; raw arguments, diagnostics, and tool output stay in runtime.
const safeText = (value: string, limit = PREVIEW_CHARACTERS, multiline = false): string => {
    if (sensitive.test(value)) return '<redacted>'
    const normalized = value
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(
            multiline
                ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g
                : /[\u0000-\u001f\u007f-\u009f]+/g,
            ' '
        )
        .replace(multiline ? /[^\S\n]+/g : /\s+/g, ' ')
        .trim()
    const characters = [...normalized]
    return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : normalized
}
const toolName = (name: string): ToolName | 'unknown_tool' => {
    switch (name) {
        case 'read_file':
        case 'list_files':
        case 'search_code':
        case 'propose_patch':
            return name
        default:
            return 'unknown_tool'
    }
}
const unique = <T>(values: readonly T[], value: T): readonly T[] =>
    values.includes(value) || values.length >= EVIDENCE_ITEMS ? values : [...values, value]
const elapsed = (record: RunRecord, sample: ClockSample): number =>
    Number.isFinite(sample.monotonicTimeMs)
        ? Math.max(record.summary.elapsedMs, 0, sample.monotonicTimeMs - record.startedMonotonicMs)
        : record.summary.elapsedMs

export const createRunRecord = (id: RunIdentity, task: string, sample: ClockSample): RunRecord => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Run number must be positive')
    if (!Number.isFinite(sample.wallTimeMs) || !Number.isFinite(sample.monotonicTimeMs)) {
        throw new Error('Initial clock sample must be finite')
    }
    return {
        summary: {
            id,
            taskPreview: safeText(task),
            startedAtMs: sample.wallTimeMs,
            elapsedMs: 0,
            status: 'running',
            activity: 'starting',
            stopReason: null,
        },
        timingAvailable: true,
        workspaceRoot: null,
        startedMonotonicMs: sample.monotonicTimeMs,
        feed: [],
        calls: [],
        tools: [],
        files: [],
        errors: [],
        approvals: [],
        result: null,
    }
}

export const projectRunEvent = (
    record: RunRecord,
    runId: RunIdentity,
    event: RunEventSnapshot,
    sample: ClockSample
): RunRecord => {
    if (record.summary.id !== runId || record.summary.status !== 'running') return record
    if (event.type === 'final_answer' || event.type === 'final_answer_delta') return record
    if (event.type === 'run_cancellation_requested' && record.summary.activity === 'cancelling') {
        return record
    }
    let workspaceRoot = record.workspaceRoot
    let activity = record.summary.activity
    let calls = record.calls
    let tools = record.tools
    let files = record.files
    let errors = record.errors
    let approvals = record.approvals
    const step = 'step' in event ? event.step : null
    const callId =
        event.type === 'tool_requested'
            ? event.call.id
            : event.type === 'tool_completed'
              ? event.result.callId
              : 'callId' in event
                ? event.callId
                : null
    const call = calls.find((item) => item.step === step && item.callId === callId)
    let tool = call?.tool ?? null
    let outcome: FeedRow['outcome'] = null
    let truncated = false
    let truncation: FeedRow['truncation'] = null

    switch (event.type) {
        case 'run_cancellation_requested':
            activity = 'cancelling'
            break
        case 'run_started':
            workspaceRoot = event.workspaceRoot
            break
        case 'model_requested':
            activity = 'model'
            break
        case 'model_responded':
            activity = event.metadata.hasFinalAnswer ? 'finishing' : 'tools'
            break
        case 'tool_requested': {
            activity = 'tools'
            tool = toolName(event.call.name)
            const parsed =
                tool === 'read_file'
                    ? readFileArgumentsSchema.safeParse(event.call.arguments)
                    : null
            calls = [
                ...calls,
                {
                    step: event.step,
                    callId: event.call.id,
                    tool,
                    readPath: parsed?.success
                        ? safeText(
                              workspaceRoot === null
                                  ? normalize(parsed.data.path)
                                  : relative(
                                        workspaceRoot,
                                        resolve(workspaceRoot, parsed.data.path)
                                    )
                          )
                        : null,
                },
            ]
            break
        }
        case 'tool_authorized':
            outcome = event.decision.decision
            if (outcome === 'allow' && tool !== null) tools = unique(tools, tool)
            break
        case 'tool_completed': {
            truncated = event.result.metadata.truncated === true
            const parsed = truncated
                ? truncationSchema.safeParse(event.result.metadata.truncation)
                : null
            if (parsed?.success) {
                const { reason, limit, observed } = parsed.data
                truncation = { reason, limit, observed }
            }
            activity = 'tools'
            outcome = event.result.status
            if (event.result.status !== 'success') {
                errors = [...errors, { step, callId, reason: event.result.status }]
            } else if (call?.readPath !== null && call?.readPath !== undefined) {
                files = unique(files, call.readPath)
            } else if (call?.tool === 'list_files' || call?.tool === 'search_code') {
                // The read tools already bound output. Retain only a capped set of path previews.
                for (const line of event.result.content.split('\n')) {
                    const path =
                        call.tool === 'list_files'
                            ? line.endsWith('/')
                                ? null
                                : line
                            : /^(.*?):\d+:/.exec(line)?.[1]
                    if (path) files = unique(files, safeText(path))
                    if (files.length >= EVIDENCE_ITEMS) break
                }
            }
            break
        }
        case 'patch_prepared':
        case 'patch_approval_requested':
        case 'patch_approval_resolved':
        case 'patch_conflicted':
        case 'patch_applied': {
            const state: ApprovalState =
                event.type === 'patch_prepared'
                    ? 'prepared'
                    : event.type === 'patch_approval_requested'
                      ? 'waiting'
                      : event.type === 'patch_approval_resolved'
                        ? event.decision
                        : event.type === 'patch_conflicted'
                          ? 'conflict'
                          : 'applied'
            outcome = state
            activity = state === 'waiting' ? 'approval' : 'tools'
            const approval: ApprovalSummary = {
                step: event.step,
                callId: event.callId,
                path: safeText(event.metadata.relativePath),
                state,
                conflict: event.type === 'patch_conflicted' ? event.conflict : null,
            }
            const index = approvals.findIndex(
                (item) => item.step === event.step && item.callId === event.callId
            )
            approvals =
                index < 0
                    ? [...approvals, approval]
                    : approvals.map((item, position) => (position === index ? approval : item))
            if (state === 'applied') files = unique(files, approval.path)
            break
        }
        case 'run_finished':
            // Only the settled session finalizes a record; this event is feed evidence.
            activity = 'finishing'
            outcome = event.reason
            break
    }
    return {
        ...record,
        workspaceRoot,
        summary: {
            ...record.summary,
            activity: record.summary.activity === 'cancelling' ? 'cancelling' : activity,
            elapsedMs: elapsed(record, sample),
        },
        calls,
        tools,
        files,
        errors,
        approvals,
        feed: [
            ...record.feed,
            {
                truncated,
                truncation,
                sequence: record.feed.length + 1,
                runId,
                type: event.type,
                step,
                callId,
                tool,
                outcome,
            },
        ],
    }
}

export const finalizeRunRecord = (
    record: RunRecord,
    runId: RunIdentity,
    session: SettledSession,
    sample: ClockSample
): RunRecord => {
    if (record.summary.id !== runId || record.summary.status !== 'running') return record
    if (
        session.status === 'pending' ||
        session.status === 'running' ||
        session.stopReason === null
    ) {
        return record
    }
    const outcome: RunOutcome =
        session.stopReason === 'step_budget_exhausted' ? 'budget_exhausted' : session.status
    const errors =
        session.stopReason === 'transport_error'
            ? [...record.errors, { step: null, callId: null, reason: 'transport_error' as const }]
            : record.errors
    return {
        ...record,
        summary: {
            ...record.summary,
            status: outcome,
            activity: null,
            stopReason: session.stopReason,
            elapsedMs: elapsed(record, sample),
        },
        errors,
        result: {
            outcome,
            stopReason: session.stopReason,
            answer:
                session.finalAnswer === null
                    ? null
                    : safeText(session.finalAnswer, ANSWER_CHARACTERS, true),
            answerTruncated:
                session.finalAnswer !== null && [...session.finalAnswer].length > ANSWER_CHARACTERS,
            tools: record.tools,
            files: record.files,
            errors,
            approvals: record.approvals,
        },
    }
}

// Explicit run identity prevents an old observer from updating a newer active run.
export const updateObservedRun = (
    history: ObservationHistory,
    id: RunIdentity,
    update: (record: RunRecord) => RunRecord
): ObservationHistory =>
    history.map((record) => {
        if (record.summary.id !== id || record.summary.status !== 'running') return record
        const next = update(record)
        return next.summary.id === id ? next : record
    })

// A CLI invocation failure is not evidence of a transport failure or user cancellation.
export const failRunRecord = (
    record: RunRecord,
    runId: RunIdentity,
    sample: ClockSample
): RunRecord => {
    if (record.summary.id !== runId || record.summary.status !== 'running') return record
    const errors: readonly ObservationError[] = [
        ...record.errors,
        { step: null, callId: null, reason: 'cli_turn_error' },
    ]
    return {
        ...record,
        summary: {
            ...record.summary,
            status: 'failed',
            activity: null,
            stopReason: 'cli_turn_error',
            elapsedMs: elapsed(record, sample),
        },
        errors,
        result: {
            outcome: 'failed',
            stopReason: 'cli_turn_error',
            answer: null,
            answerTruncated: false,
            tools: record.tools,
            files: record.files,
            errors,
            approvals: record.approvals,
        },
    }
}
