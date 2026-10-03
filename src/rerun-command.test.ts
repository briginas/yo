import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRerunCommand } from './rerun-command.ts'

test('recognizes rerun with canonical positive safe numbers and space/tab separators', () => {
    for (const line of ['/rerun 2', ' /rerun\t2 ', '\t/rerun   2\t', '/rerun \t 2']) {
        assert.deepEqual(parseRerunCommand(line), { type: 'rerun', sourceId: 2 }, line)
    }
    assert.deepEqual(parseRerunCommand('/rerun 1'), { type: 'rerun', sourceId: 1 })
    assert.deepEqual(parseRerunCommand('/rerun 9007199254740991'), {
        type: 'rerun',
        sourceId: Number.MAX_SAFE_INTEGER,
    })
})

test('keeps malformed reserved rerun input local', () => {
    for (const line of [
        '/rerun',
        ' /rerun\t ',
        '/rerun 0',
        '/rerun -1',
        '/rerun +1',
        '/rerun 01',
        '/rerun 1.5',
        '/rerun 1e2',
        '/rerun 0x1',
        '/rerun 9007199254740992',
        `/rerun ${'9'.repeat(400)}`,
        '/rerun 1 extra',
        '/rerun NaN',
        '/rerun Infinity',
        '/rerun ١',
    ]) {
        assert.deepEqual(parseRerunCommand(line), { type: 'invalid' }, line)
    }
})

test('leaves ordinary tokens and existing commands to their existing handlers', () => {
    for (const line of [
        '/rerunner',
        '/rerunbook',
        '/RERUN 1',
        '/rerun/1',
        '/runs',
        '/run 1',
        '/exit',
        ' /exit ',
        ' Inspect 🧩 ',
        '',
        ' \t ',
    ]) {
        assert.deepEqual(parseRerunCommand(line), { type: 'message' }, line)
    }
})
