import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRunController, type RunController } from './run-controller.ts'

const deferred = <Value>() => Promise.withResolvers<Value>()

test('registers the controller before invocation and supports cancellation before start', async () => {
    let owner: RunController<string> | undefined
    let invocationCount = 0
    owner = createRunController(async (signal) => {
        invocationCount += 1
        assert.ok(owner)
        assert.equal(signal, owner.signal)
        assert.equal(signal.aborted, true)
        return 'pre-aborted turn result'
    })

    assert.equal(invocationCount, 0)
    owner.requestCancellation()
    assert.equal(await owner.settled, 'pre-aborted turn result')
    assert.equal(invocationCount, 1)
})

test('repeated requests abort the same active signal once without settling held work', async () => {
    const started = deferred<void>()
    const work = deferred<string>()
    let abortCount = 0
    let hasSettled = false
    const controller = createRunController(async (signal) => {
        signal.addEventListener(
            'abort',
            () => {
                abortCount += 1
            },
            { once: true }
        )
        started.resolve()
        return work.promise
    })
    const observation = controller.settled.then(() => {
        hasSettled = true
    })
    await started.promise

    controller.requestCancellation()
    controller.requestCancellation()
    controller.requestCancellation()
    await Promise.resolve()

    assert.equal(controller.signal.aborted, true)
    assert.equal(abortCount, 1)
    assert.equal(hasSettled, false)
    work.resolve('settled by executor')
    assert.equal(await controller.settled, 'settled by executor')
    await observation
    assert.equal(hasSettled, true)
})

test('waits for cleanup and the complete turn result after cancellation', async () => {
    const started = deferred<void>()
    const work = deferred<void>()
    const cleaningUp = deferred<void>()
    const cleanup = deferred<void>()
    const result = { conversation: ['task', 'tool result'], outcome: 'aborted' }
    let hasSettled = false
    const controller = createRunController(async () => {
        started.resolve()
        try {
            await work.promise
        } finally {
            cleaningUp.resolve()
            await cleanup.promise
        }
        return result
    })
    const observation = controller.settled.then(() => {
        hasSettled = true
    })
    await started.promise

    controller.requestCancellation()
    work.resolve()
    await cleaningUp.promise
    assert.equal(hasSettled, false)
    cleanup.resolve()
    assert.equal(await controller.settled, result)
    await observation
})

test('preserves the executor outcome when completion has won before outer cleanup', async () => {
    const committed = deferred<void>()
    const cleanup = deferred<void>()
    const result = { status: 'completed', reason: 'final_answer', answer: 'Done.' } as const
    const controller = createRunController(async () => {
        committed.resolve()
        await cleanup.promise
        return result
    })
    await committed.promise

    controller.requestCancellation()
    cleanup.resolve()
    assert.equal(await controller.settled, result)
    assert.equal(controller.signal.aborted, true)
})

test('preserves invocation rejection after cleanup and closes later cancellation requests', async () => {
    const cleaningUp = deferred<void>()
    const cleanup = deferred<void>()
    const failure = new Error('controlled invocation failure')
    const controller = createRunController(async () => {
        try {
            throw failure
        } finally {
            cleaningUp.resolve()
            await cleanup.promise
        }
    })
    let hasRejected = false
    const rejection = assert.rejects(controller.settled, (error: unknown) => {
        hasRejected = true
        assert.equal(error, failure)
        return true
    })
    await cleaningUp.promise
    assert.equal(hasRejected, false)

    cleanup.resolve()
    await rejection
    controller.requestCancellation()
    assert.equal(controller.signal.aborted, false)
})

test('captures a synchronous invocation throw in the settlement promise', async () => {
    const failure = new Error('synchronous invocation failure')
    const controller = createRunController(() => {
        throw failure
    })

    await assert.rejects(controller.settled, (error: unknown) => error === failure)
    controller.requestCancellation()
    assert.equal(controller.signal.aborted, false)
})

test('a settled old controller cannot cancel itself or a newer operation', async () => {
    const first = createRunController(async () => 'first result')
    assert.equal(await first.settled, 'first result')
    const started = deferred<void>()
    const work = deferred<string>()
    const second = createRunController(async () => {
        started.resolve()
        return work.promise
    })
    await started.promise

    first.requestCancellation()
    first.dispose()
    first.requestCancellation()
    assert.notEqual(first.signal, second.signal)
    assert.equal(first.signal.aborted, false)
    assert.equal(second.signal.aborted, false)

    second.requestCancellation()
    assert.equal(second.signal.aborted, true)
    work.resolve('second result')
    assert.equal(await second.settled, 'second result')
})

test('idempotent disposal does not abort, detach, or prematurely settle owned work', async () => {
    const started = deferred<void>()
    const work = deferred<string>()
    let hasSettled = false
    const controller = createRunController(async () => {
        started.resolve()
        return work.promise
    })
    const observation = controller.settled.then(() => {
        hasSettled = true
    })
    await started.promise

    controller.dispose()
    controller.dispose()
    controller.requestCancellation()
    await Promise.resolve()
    assert.equal(controller.signal.aborted, false)
    assert.equal(hasSettled, false)

    work.resolve('still owned')
    assert.equal(await controller.settled, 'still owned')
    await observation
})
