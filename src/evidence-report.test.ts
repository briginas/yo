import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatEvidenceReport, formatSessionReport } from './evidence-report.ts'
import type { SessionState } from './runtime/run.ts'

const createSession = (): SessionState => ({
    task: 'Inspect the workspace.',
    workspaceRoot: '/approved/workspace',
    budget: {
        maxSteps: 10,
        perToolTimeoutMs: 5_000,
    },
    status: 'completed',
    stepCount: 1,
    messages: [],
    events: [],
    finalAnswer: 'Found the runtime entrypoint.',
    stopReason: 'final_answer',
})

test('preserves the exact ask report shape', () => {
    assert.equal(
        formatSessionReport(createSession()),
        [
            'Found the runtime entrypoint.',
            '',
            'Evidence:',
            'Stop reason: final_answer',
            'Tools: (none)',
            'Files:',
            '- (none)',
        ].join('\n')
    )
})

test('formats answer-free chat evidence from authorized successful observations', () => {
    const session = createSession()

    session.events = [
        {
            type: 'tool_requested',
            step: 1,
            call: {
                id: 'search-call',
                name: 'search_code',
                arguments: { query: 'entrypoint', path: 'src' },
            },
        },
        {
            type: 'tool_authorized',
            step: 1,
            callId: 'search-call',
            decision: { decision: 'allow' },
        },
        {
            type: 'tool_completed',
            step: 1,
            result: {
                status: 'success',
                callId: 'search-call',
                content: [
                    'src/cli.ts:1:#!/usr/bin/env node',
                    'src/cli.ts:4:import { runCli } from "./cli-app.ts"',
                ].join('\n'),
                metadata: { truncated: false, truncation: null },
            },
        },
        {
            type: 'tool_requested',
            step: 1,
            call: {
                id: 'read-call',
                name: 'read_file',
                arguments: { path: './src/cli.ts' },
            },
        },
        {
            type: 'tool_authorized',
            step: 1,
            callId: 'read-call',
            decision: { decision: 'allow' },
        },
        {
            type: 'tool_completed',
            step: 1,
            result: {
                status: 'success',
                callId: 'read-call',
                content: '1:#!/usr/bin/env node',
                metadata: { truncated: false, truncation: null },
            },
        },
    ]

    const report = formatEvidenceReport(session)

    assert.equal(
        report,
        [
            'Evidence:',
            'Stop reason: final_answer',
            'Tools: search_code, read_file',
            'Files:',
            '- src/cli.ts',
        ].join('\n')
    )
    assert.equal(report.includes(session.finalAnswer!), false)
})
