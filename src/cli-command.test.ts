import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCliCommand, USAGE } from './cli-command.ts'

test('parses the bounded chat command', () => {
    assert.deepEqual(parseCliCommand(['chat', '--cwd', '.']), {
        status: 'success',
        command: {
            name: 'chat',
            cwd: '.',
            model: null,
        },
    })
    assert.deepEqual(parseCliCommand(['chat', '--model', 'chosen-model', '--cwd', '/workspace']), {
        status: 'success',
        command: {
            name: 'chat',
            cwd: '/workspace',
            model: 'chosen-model',
        },
    })
    assert.match(USAGE, /yo chat --cwd <workspace> \[--model <name>\]/)
})

test('rejects invalid bounded chat arguments', async (context) => {
    const cases = [
        {
            name: 'missing cwd',
            argv: ['chat'],
            message: '--cwd is required',
        },
        {
            name: 'missing cwd value',
            argv: ['chat', '--cwd'],
            message: '--cwd requires a non-empty value',
        },
        {
            name: 'empty cwd',
            argv: ['chat', '--cwd', ''],
            message: '--cwd requires a non-empty value',
        },
        {
            name: 'whitespace cwd',
            argv: ['chat', '--cwd', '   '],
            message: '--cwd requires a non-empty value',
        },
        {
            name: 'option-like cwd',
            argv: ['chat', '--cwd', '--model'],
            message: '--cwd requires a non-empty value',
        },
        {
            name: 'duplicate cwd',
            argv: ['chat', '--cwd', '.', '--cwd', '.'],
            message: '--cwd may be specified only once',
        },
        {
            name: 'missing model value',
            argv: ['chat', '--cwd', '.', '--model'],
            message: '--model requires a non-empty value',
        },
        {
            name: 'empty model',
            argv: ['chat', '--cwd', '.', '--model', ''],
            message: '--model requires a non-empty value',
        },
        {
            name: 'duplicate model',
            argv: ['chat', '--cwd', '.', '--model', 'one', '--model', 'two'],
            message: '--model may be specified only once',
        },
        {
            name: 'unknown option',
            argv: ['chat', '--cwd', '.', '--verbose'],
            message: 'Unknown option: --verbose',
        },
        {
            name: 'positional argument',
            argv: ['chat', 'task', '--cwd', '.'],
            message: 'chat does not accept positional arguments',
        },
        {
            name: 'extra argument',
            argv: ['chat', '--cwd', '.', 'extra'],
            message: 'chat does not accept positional arguments',
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
        message: 'Expected the chat, login, auth status, or logout command',
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
