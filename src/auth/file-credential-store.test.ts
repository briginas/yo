import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { OPENAI_CODEX_PROVIDER_ID, type Credential } from './credential.ts'
import { createFileCredentialStore } from './file-credential-store.ts'

const providerId = OPENAI_CODEX_PROVIDER_ID
const credential = {
    type: 'oauth',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 1_800_000_000_000,
    accountId: 'account-123',
} as const satisfies Credential
const updatedCredential = {
    ...credential,
    accessToken: 'updated-access-token',
    refreshToken: 'updated-refresh-token',
    expiresAt: 1_900_000_000_000,
} as const satisfies Credential

const fixtureRoots: string[] = []

const createFixture = async (): Promise<{ authPath: string; root: string }> => {
    const root = await mkdtemp(join(tmpdir(), 'yo-credential-store-'))
    const authPath = join(root, '.yo', 'auth.json')

    fixtureRoots.push(root)
    return { authPath, root }
}

const readMode = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777

const createDeferred = (): {
    promise: Promise<void>
    resolve: () => void
} => {
    let resolvePromise: (() => void) | undefined
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve
    })

    return {
        promise,
        resolve: () => resolvePromise?.(),
    }
}

const yieldToEventLoop = (): Promise<void> =>
    new Promise((resolve) => {
        setImmediate(resolve)
    })

afterEach(async () => {
    await Promise.all(
        fixtureRoots.splice(0).map((fixtureRoot) => rm(fixtureRoot, { recursive: true }))
    )
})

describe('createFileCredentialStore', () => {
    test('creates, reads, updates, preserves, and deletes a credential', async () => {
        const { authPath } = await createFixture()
        const store = createFileCredentialStore({ authPath })

        assert.equal(await store.read(providerId), undefined)

        assert.deepEqual(
            await store.modify(providerId, async (current) => {
                assert.equal(current, undefined)
                return credential
            }),
            credential
        )
        assert.deepEqual(await store.read(providerId), credential)

        assert.deepEqual(
            await store.modify(providerId, async (current) => {
                assert.deepEqual(current, credential)
                return updatedCredential
            }),
            updatedCredential
        )

        const contentBeforePreserving = await readFile(authPath, 'utf8')

        assert.deepEqual(
            await store.modify(providerId, async (current) => {
                assert.deepEqual(current, updatedCredential)
                return undefined
            }),
            updatedCredential
        )
        assert.equal(await readFile(authPath, 'utf8'), contentBeforePreserving)

        await store.delete(providerId)

        assert.equal(await store.read(providerId), undefined)
        assert.deepEqual(JSON.parse(await readFile(authPath, 'utf8')), {})
    })

    test('creates and repairs restrictive directory and file permissions', async () => {
        const { authPath } = await createFixture()
        const store = createFileCredentialStore({ authPath })

        await store.modify(providerId, async () => credential)

        assert.equal(await readMode(dirname(authPath)), 0o700)
        assert.equal(await readMode(authPath), 0o600)

        await chmod(dirname(authPath), 0o777)
        await chmod(authPath, 0o666)
        await store.read(providerId)

        assert.equal(await readMode(dirname(authPath)), 0o700)
        assert.equal(await readMode(authPath), 0o600)
    })

    test('rejects an auth path that is not a regular file', async () => {
        const { authPath } = await createFixture()

        await mkdir(authPath, { recursive: true })

        const store = createFileCredentialStore({ authPath })

        await assert.rejects(
            store.read(providerId),
            new Error('OAuth credential store must be a regular file')
        )
    })

    test('rejects malformed files without exposing their contents', async () => {
        const malformedFiles = [
            '{not-json',
            JSON.stringify({
                'openai-codex': {
                    ...credential,
                    accessToken: 'leaked-access-token',
                    expiresAt: 'invalid-expiry',
                },
            }),
            JSON.stringify({
                'openai-codex': credential,
                unknownProvider: { token: 'leaked-unknown-token' },
            }),
        ]

        for (const content of malformedFiles) {
            const { authPath } = await createFixture()

            await mkdir(dirname(authPath), { recursive: true })
            await writeFile(authPath, content, { mode: 0o600 })

            const store = createFileCredentialStore({ authPath })

            await assert.rejects(store.read(providerId), (error: unknown) => {
                assert.equal(
                    error instanceof Error ? error.message : String(error),
                    'OAuth credential store is malformed'
                )
                assert.doesNotMatch(String(error), /leaked-|not-json/)
                return true
            })
        }
    })

    test('serializes concurrent modifications and passes the latest credential forward', async () => {
        const { authPath } = await createFixture()
        const firstStore = createFileCredentialStore({ authPath })
        const secondStore = createFileCredentialStore({ authPath })
        const firstCallbackEntered = createDeferred()
        const releaseFirstCallback = createDeferred()
        let firstCallbackReleased = false
        let secondCallbackEntered = false

        const firstModification = firstStore.modify(providerId, async (current) => {
            assert.equal(current, undefined)
            firstCallbackEntered.resolve()
            await releaseFirstCallback.promise
            firstCallbackReleased = true
            return credential
        })

        await firstCallbackEntered.promise

        const secondModification = secondStore.modify(providerId, async (current) => {
            secondCallbackEntered = true
            assert.equal(firstCallbackReleased, true)
            assert.deepEqual(current, credential)
            return updatedCredential
        })

        try {
            await yieldToEventLoop()
            assert.equal(secondCallbackEntered, false)
        } finally {
            releaseFirstCallback.resolve()
        }

        assert.deepEqual(await firstModification, credential)
        assert.deepEqual(await secondModification, updatedCredential)
        assert.equal(secondCallbackEntered, true)
        assert.deepEqual(await secondStore.read(providerId), updatedCredential)
    })
})
