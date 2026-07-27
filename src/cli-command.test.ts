import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCliCommand, USAGE } from './cli-command.ts'

test('parses the agent workflow with optional cwd and model flags', () => {
    assert.deepEqual(parseCliCommand([]), {
        status: 'success',
        command: {
            name: 'chat',
            cwd: null,
            model: null,
        },
    })
    assert.deepEqual(parseCliCommand(['--cwd', '.']), {
        status: 'success',
        command: {
            name: 'chat',
            cwd: '.',
            model: null,
        },
    })
    assert.deepEqual(parseCliCommand(['--model', 'chosen-model']), {
        status: 'success',
        command: {
            name: 'chat',
            cwd: null,
            model: 'chosen-model',
        },
    })
    assert.deepEqual(parseCliCommand(['--model', 'chosen-model', '--cwd', '/workspace']), {
        status: 'success',
        command: {
            name: 'chat',
            cwd: '/workspace',
            model: 'chosen-model',
        },
    })
    assert.match(USAGE, /yo \[--cwd <workspace>\] \[--model <name>\]/)
    assert.doesNotMatch(USAGE, /yo chat/)
})

test('rejects invalid agent workflow arguments', async (context) => {
    const cases = [
        {
            name: 'missing cwd value',
            argv: ['--cwd'],
            message: '--cwd requires a non-empty value',
        },
        {
            name: 'empty cwd',
            argv: ['--cwd', ''],
            message: '--cwd requires a non-empty value',
        },
        {
            name: 'whitespace cwd',
            argv: ['--cwd', '   '],
            message: '--cwd requires a non-empty value',
        },
        {
            name: 'option-like cwd',
            argv: ['--cwd', '--model'],
            message: '--cwd requires a non-empty value',
        },
        {
            name: 'duplicate cwd',
            argv: ['--cwd', '.', '--cwd', '.'],
            message: '--cwd may be specified only once',
        },
        {
            name: 'missing model value',
            argv: ['--cwd', '.', '--model'],
            message: '--model requires a non-empty value',
        },
        {
            name: 'empty model',
            argv: ['--cwd', '.', '--model', ''],
            message: '--model requires a non-empty value',
        },
        {
            name: 'duplicate model',
            argv: ['--cwd', '.', '--model', 'one', '--model', 'two'],
            message: '--model may be specified only once',
        },
        {
            name: 'unknown option',
            argv: ['--cwd', '.', '--verbose'],
            message: 'Unknown option: --verbose',
        },
        {
            name: 'removed chat command',
            argv: ['chat', '--cwd', '.'],
            message: 'yo does not accept positional arguments',
        },
        {
            name: 'extra argument',
            argv: ['--cwd', '.', 'extra'],
            message: 'yo does not accept positional arguments',
        },
    ] as const

    for (const testCase of cases) {
        await context.test(testCase.name, () => {
            assert.deepEqual(parseCliCommand(testCase.argv), {
                status: 'error',
                message: testCase.message,
            })
        })
    }
})

test('rejects the removed ask command', () => {
    assert.deepEqual(parseCliCommand(['ask', 'Inspect.', '--cwd', '.']), {
        status: 'error',
        message: 'yo does not accept positional arguments',
    })
    assert.doesNotMatch(USAGE, /yo ask/)
})

test('preserves authentication command parsing', () => {
    assert.deepEqual(parseCliCommand(['login']), {
        status: 'success',
        command: { name: 'login' },
    })
    assert.deepEqual(parseCliCommand(['auth', 'status']), {
        status: 'success',
        command: { name: 'auth_status' },
    })
    assert.deepEqual(parseCliCommand(['logout']), {
        status: 'success',
        command: { name: 'logout' },
    })
})
