import assert from 'node:assert/strict'
import test from 'node:test'
import { parseObservationCommand } from './observation-command.ts'

test('recognizes only local inspection tokens and canonical safe run numbers', () => {
    for (const line of ['/runs', ' /runs\t']) {
        assert.deepEqual(parseObservationCommand(line), { type: 'list' })
    }
    for (const line of ['/run 2', ' /run\t2 ', '/run   2']) {
        assert.deepEqual(parseObservationCommand(line), { type: 'inspect', id: 2 })
    }
    assert.deepEqual(parseObservationCommand('/run 9007199254740991'), {
        type: 'inspect',
        id: Number.MAX_SAFE_INTEGER,
    })
    for (const line of [
        '/run',
        '/run 0',
        '/run -1',
        '/run +1',
        '/run 01',
        '/run 1.5',
        '/run 1e2',
        '/run 9007199254740992',
        '/run 1 extra',
        '/runs extra',
        '/run NaN',
        '/run Infinity',
    ])
        assert.deepEqual(parseObservationCommand(line), { type: 'invalid' }, line)
    for (const line of ['/runner', '/runbook', '/RUN 1', ' Inspect ', ' /exit ', '', '/run/1']) {
        assert.deepEqual(parseObservationCommand(line), { type: 'message' }, line)
    }
})
