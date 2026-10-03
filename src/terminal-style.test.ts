import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalTechnicalFormatter } from './terminal-style.ts'

test('technical styling resets intensity without changing foreground color', () => {
    const format = createTerminalTechnicalFormatter({ isInteractive: true })
    assert.equal(format('event: model_requested\n'), '\u001b[2mevent: model_requested\n\u001b[22m')
    assert.equal(format(''), '')
    assert.equal(format('state: model'), '\u001b[2mstate: model\u001b[22m')
})

test('non-interactive output and plain-terminal opt-outs preserve text byte for byte', () => {
    for (const options of [
        { isInteractive: false },
        { isInteractive: true, noColor: '1' },
        { isInteractive: true, noColor: '0' },
        { isInteractive: true, term: 'dumb' },
    ]) {
        const format = createTerminalTechnicalFormatter(options)
        assert.equal(format('state: model\n'), 'state: model\n')
    }
    assert.equal(
        createTerminalTechnicalFormatter({ isInteractive: true, noColor: '' })('state: model'),
        '\u001b[2mstate: model\u001b[22m'
    )
})
