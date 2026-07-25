import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
    credentialProviderIdSchema,
    credentialSchema,
    OPENAI_CODEX_PROVIDER_ID,
    type Credential,
    type CredentialProviderId,
    type CredentialStore,
} from './credential.ts'

type RuntimeSchema = {
    safeParse: (input: unknown) => { success: boolean }
}

const assertRejected = (schema: RuntimeSchema, inputs: unknown[]) => {
    for (const input of inputs) {
        assert.equal(
            schema.safeParse(input).success,
            false,
            `expected rejection for ${JSON.stringify(input)}`
        )
    }
}

const credential = {
    type: 'oauth',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 1_800_000_000_000,
    accountId: 'account-123',
} as const satisfies Credential

const createTestStore = (): CredentialStore => {
    const credentials = new Map<CredentialProviderId, Credential>()

    return {
        read: async (providerId) => credentials.get(providerId),
        modify: async (providerId, update) => {
            const current = credentials.get(providerId)
            const next = await update(current)

            if (next !== undefined) {
                credentials.set(providerId, next)
            }

            return next ?? current
        },
        delete: async (providerId) => {
            credentials.delete(providerId)
        },
    }
}

describe('credentialProviderIdSchema', () => {
    test('accepts only the provider approved for milestone 1', () => {
        assert.equal(credentialProviderIdSchema.parse('openai-codex'), 'openai-codex')

        assertRejected(credentialProviderIdSchema, ['', 'openrouter', 'openai'])
    })
})

describe('credentialSchema', () => {
    test('accepts a complete OpenAI Codex OAuth credential', () => {
        assert.deepEqual(credentialSchema.parse(credential), credential)
    })

    test('rejects missing, empty, mistyped, and unknown fields', () => {
        assertRejected(credentialSchema, [
            {
                type: 'oauth',
                refreshToken: 'refresh-token',
                expiresAt: 1_800_000_000_000,
                accountId: 'account-123',
            },
            { ...credential, accessToken: '' },
            { ...credential, refreshToken: '' },
            { ...credential, accountId: '' },
            { ...credential, type: 'api_key' },
            { ...credential, expiresAt: '1_800_000_000_000' },
            { ...credential, unknown: true },
        ])
    })

    test('rejects negative and fractional expiry timestamps', () => {
        assertRejected(credentialSchema, [
            { ...credential, expiresAt: -1 },
            { ...credential, expiresAt: 1.5 },
        ])
    })
})

test('CredentialStore supports provider-keyed read, modify, and delete', async () => {
    const store = createTestStore()
    const providerId: CredentialProviderId = OPENAI_CODEX_PROVIDER_ID

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
            return undefined
        }),
        credential
    )

    await store.delete(providerId)

    assert.equal(await store.read(providerId), undefined)
})
