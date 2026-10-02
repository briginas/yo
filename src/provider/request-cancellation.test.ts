import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Credential, CredentialStore } from '../auth/credential.ts'
import {
    refreshOpenAICodexCredential,
    resolveOpenAICodexCredential,
} from '../auth/openai-codex-login.ts'
import type { ModelRequest } from '../runtime/run.ts'
import { OperationAbortedError } from '../runtime/settled-operation.ts'
import {
    createOpenAICodexResponsesTransport,
    parseOpenAICodexResponsesSse,
} from './openai-codex-responses.ts'

const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}
const tick = () => new Promise<void>((done) => setImmediate(done))
const credential: Credential = {
    type: 'oauth',
    accessToken: 'private-access',
    refreshToken: 'private-refresh',
    expiresAt: 10,
    accountId: 'account',
}
const request: ModelRequest = { model: null, messages: [], visibleTools: [] }
const store: CredentialStore = {
    read: async () => credential,
    modify: async (_, update) => update(credential),
    delete: async () => {},
}

for (const phase of ['pre', 'read', 'lock', 'refresh', 'persist'] as const) {
    test(`credential cancellation during ${phase} awaits owned work and blocks model fetch`, async () => {
        const abort = new AbortController()
        const entered = deferred<void>()
        const held = deferred<void>()
        let persisted: Credential | undefined
        let released = false
        let refreshes = 0
        let fetches = 0
        let settled = false
        const rotated = { ...credential, accessToken: 'rotated', expiresAt: 100 }
        const pause = async (at: typeof phase) => {
            if (phase === at) {
                entered.resolve()
                await held.promise
            }
        }
        const credentialStore: CredentialStore = {
            read: async () => {
                await pause('read')
                return credential
            },
            modify: async (_, update) => {
                try {
                    await pause('lock')
                    const next = await update(credential)
                    await pause('persist')
                    persisted = next
                    return next
                } finally {
                    released = true
                }
            },
            delete: async () => {},
        }
        if (phase === 'pre') abort.abort('private-abort-reason')
        const transport = createOpenAICodexResponsesTransport({
            credentialStore,
            resolveCredential: (options) =>
                resolveOpenAICodexCredential({
                    ...options,
                    now: () => 10,
                    refreshCredential: async ({ signal }) => {
                        assert.equal(signal, abort.signal)
                        refreshes++
                        await pause('refresh')
                        return rotated
                    },
                }),
            fetch: async () => {
                fetches++
                throw new Error('must not fetch')
            },
        })
        const result = transport(request, { signal: abort.signal })
        const checked = assert.rejects(result, OperationAbortedError).then(() => {
            settled = true
        })
        if (phase !== 'pre') {
            await entered.promise
            abort.abort('private-abort-reason')
            await tick()
            assert.equal(settled, false)
            held.resolve()
        }
        await checked
        assert.equal(fetches, 0)
        assert.equal(refreshes, phase === 'refresh' || phase === 'persist' ? 1 : 0)
        assert.equal(released, phase !== 'pre' && phase !== 'read')
        assert.deepEqual(
            persisted,
            phase === 'refresh' || phase === 'persist' ? rotated : undefined
        )
    })
}

test('refresh fetch receives abort, sanitizes cancellation, and releases HTTP error body', async () => {
    const abort = new AbortController()
    const started = deferred<void>()
    const result = refreshOpenAICodexCredential({
        refreshToken: 'private-refresh',
        signal: abort.signal,
        fetch: async (_, options) => {
            assert.equal(options?.signal, abort.signal)
            started.resolve()
            await new Promise<void>((_, reject) =>
                options?.signal?.addEventListener(
                    'abort',
                    () => reject(new Error('private-refresh-token')),
                    { once: true }
                )
            )
            throw new Error('unreachable')
        },
    })
    const checked = assert.rejects(result, OperationAbortedError)
    await started.promise
    abort.abort('private-reason')
    await checked
    let cleaned = false
    await assert.rejects(
        refreshOpenAICodexCredential({
            refreshToken: 'private-refresh',
            fetch: async () =>
                new Response(
                    new ReadableStream({
                        cancel() {
                            cleaned = true
                        },
                    }),
                    { status: 400 }
                ),
        }),
        /OAuth credential refresh failed/
    )
    assert.equal(cleaned, true)
})

for (const lateSuccess of [false, true]) {
    test(`pending model fetch cancellation awaits ${lateSuccess ? 'late response body cleanup' : 'fetch rejection'}`, async () => {
        const abort = new AbortController()
        const entered = deferred<void>()
        const release = deferred<void>()
        const cleanup = deferred<void>()
        let cancelled = false
        let settled = false
        const transport = createOpenAICodexResponsesTransport({
            credentialStore: store,
            resolveCredential: async () => credential,
            fetch: async (_, options) => {
                assert.equal(options?.signal, abort.signal)
                entered.resolve()
                await release.promise
                if (!lateSuccess) throw new Error('private-network-payload')
                return new Response(
                    new ReadableStream({
                        cancel: async () => {
                            cancelled = true
                            await cleanup.promise
                        },
                    })
                )
            },
        })
        const checked = assert
            .rejects(transport(request, { signal: abort.signal }), OperationAbortedError)
            .then(() => {
                settled = true
            })
        await entered.promise
        abort.abort()
        await tick()
        assert.equal(settled, false)
        release.resolve()
        await tick()
        if (lateSuccess) {
            assert.equal(cancelled, true)
            assert.equal(settled, false)
        }
        cleanup.resolve()
        await checked
    })
}

test('SSE pending read cancellation awaits reader cleanup and releases lock', async () => {
    const abort = new AbortController()
    const cleanup = deferred<void>()
    let cancelled = false
    let settled = false
    const response = new Response(
        new ReadableStream({
            cancel: async () => {
                cancelled = true
                await cleanup.promise
            },
        })
    )
    const deltas: string[] = []
    const checked = assert
        .rejects(
            parseOpenAICodexResponsesSse(response, (delta) => deltas.push(delta), abort.signal),
            OperationAbortedError
        )
        .then(() => {
            settled = true
        })
    await tick()
    abort.abort('private-reason')
    await tick()
    assert.equal(cancelled, true)
    assert.equal(settled, false)
    cleanup.resolve()
    await checked
    assert.equal(response.body?.locked, false)
    assert.deepEqual(deltas, [])
})

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const item = { type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }
const confirmed =
    event({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello ' }) +
    event({ type: 'response.output_text.delta', output_index: 0, delta: 'world' }) +
    event({ type: 'response.output_item.done', output_index: 0, item }) +
    event({ type: 'response.completed', response: { model: 'test', output: [item] } })

test('abort from confirmed callback preserves partial text and suppresses remaining text/completion', async () => {
    const abort = new AbortController()
    const deltas: string[] = []
    await assert.rejects(
        parseOpenAICodexResponsesSse(
            new Response(confirmed),
            (delta) => {
                deltas.push(delta)
                abort.abort()
            },
            abort.signal
        ),
        OperationAbortedError
    )
    assert.deepEqual(deltas, ['Hello '])
})

test('late completed response cannot pass cancellation during awaited cleanup', async () => {
    const abort = new AbortController()
    const cleanup = deferred<void>()
    const entered = deferred<void>()
    const transport = createOpenAICodexResponsesTransport({
        credentialStore: store,
        resolveCredential: async () => credential,
        fetch: async () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(confirmed))
                    },
                    cancel: async () => {
                        entered.resolve()
                        await cleanup.promise
                    },
                })
            ),
    })
    const checked = assert.rejects(
        transport(request, { signal: abort.signal }),
        OperationAbortedError
    )
    await entered.promise
    abort.abort()
    cleanup.resolve()
    await checked
})

test('HTTP error awaits cleanup even if cancellation arrives, without provider body exposure', async () => {
    const abort = new AbortController()
    const cleanup = deferred<void>()
    const entered = deferred<void>()
    const transport = createOpenAICodexResponsesTransport({
        credentialStore: store,
        resolveCredential: async () => credential,
        fetch: async () =>
            new Response(
                new ReadableStream({
                    cancel: async () => {
                        entered.resolve()
                        await cleanup.promise
                    },
                }),
                { status: 429 }
            ),
    })
    const checked = assert.rejects(
        transport(request, { signal: abort.signal }),
        OperationAbortedError
    )
    await entered.promise
    abort.abort()
    cleanup.resolve()
    await checked
})
