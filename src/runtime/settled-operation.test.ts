import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    checkOperationSignal,
    executeSettledOperation,
    OperationAbortedError,
} from './settled-operation.ts'

const drain = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve))
}

for (const first of ['timeout', 'aborted'] as const) {
    test(`${first} wins both stop requests while work and cleanup remain owned`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const controller = new AbortController()
        const work = Promise.withResolvers<void>()
        const cleanup = Promise.withResolvers<void>()
        let operationSignal: AbortSignal | undefined
        let settled = false
        let aborts = 0
        const pending = executeSettledOperation(
            async (signal) => {
                operationSignal = signal
                signal.addEventListener('abort', () => {
                    aborts += 1
                })
                try {
                    await work.promise
                } finally {
                    await cleanup.promise
                }
                return 'late result'
            },
            { signal: controller.signal, timeoutMs: 10 }
        ).then((result) => {
            settled = true
            return result
        })
        if (first === 'timeout') {
            t.mock.timers.tick(10)
            controller.abort('private cancellation reason')
        } else {
            controller.abort('private cancellation reason')
            t.mock.timers.tick(10)
        }
        assert.equal(operationSignal?.aborted, true)
        assert.equal(aborts, 1)
        assert.equal(settled, false)
        work.resolve()
        await drain()
        assert.equal(settled, false)
        cleanup.resolve()
        assert.deepEqual(await pending, { status: first })
        controller.abort()
        assert.equal(aborts, 1)
    })
}

for (const outcome of ['success', 'denied', 'rejection', 'pre-abort'] as const) {
    test(`${outcome} settles once and disposes its timer and external listener`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const controller = new AbortController()
        const add = t.mock.method(controller.signal, 'addEventListener')
        const remove = t.mock.method(controller.signal, 'removeEventListener')
        if (outcome === 'pre-abort') {
            controller.abort('private')
        }
        let executions = 0
        let operationSignal: AbortSignal | undefined
        const error = new Error('controlled rejection')
        const pending = executeSettledOperation(
            async (signal) => {
                executions += 1
                operationSignal = signal
                if (outcome === 'rejection') {
                    throw error
                }
                return outcome
            },
            { signal: controller.signal, timeoutMs: 10 }
        )
        if (outcome === 'rejection') {
            await assert.rejects(pending, (actual) => actual === error)
        } else {
            assert.deepEqual(
                await pending,
                outcome === 'pre-abort'
                    ? { status: 'aborted' }
                    : { status: 'completed', result: outcome }
            )
        }
        assert.equal(executions, outcome === 'pre-abort' ? 0 : 1)
        assert.equal(add.mock.callCount(), 1)
        assert.equal(remove.mock.callCount(), 1)
        assert.equal(add.mock.calls[0]?.arguments[1], remove.mock.calls[0]?.arguments[1])
        controller.abort('later request')
        t.mock.timers.tick(100)
        assert.equal(operationSignal?.aborted, outcome === 'pre-abort' ? undefined : false)
    })
}

test('classifies stop after cleanup rejection without leaking external abort reason', async () => {
    const controller = new AbortController()
    const held = Promise.withResolvers<void>()
    const pending = executeSettledOperation(
        async (signal) => {
            try {
                await held.promise
                checkOperationSignal(signal)
                return 'unexpected'
            } finally {
                throw new Error('private cleanup failure')
            }
        },
        { signal: controller.signal }
    )
    controller.abort(new Error('private reason'))
    held.resolve()
    assert.deepEqual(await pending, { status: 'aborted' })
    assert.throws(() => checkOperationSignal(controller.signal), OperationAbortedError)
    assert.throws(() => checkOperationSignal(controller.signal), {
        message: 'Tool execution was aborted',
    })
})

test('captures synchronous invocation failure and keeps cancellation from relabeling it', async () => {
    const controller = new AbortController()
    const error = new Error('sync error')
    await assert.rejects(
        executeSettledOperation(
            () => {
                throw error
            },
            { signal: controller.signal }
        ),
        (actual) => actual === error
    )
    controller.abort()
})
