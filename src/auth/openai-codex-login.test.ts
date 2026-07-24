import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import type { Credential, CredentialStore } from './credential.ts'
import { createFileCredentialStore } from './file-credential-store.ts'
import {
    createOpenAICodexAuthorization,
    exchangeOpenAICodexAuthorizationCode,
    OPENAI_CODEX_AUTH_CLAIM,
    refreshOpenAICodexCredential,
    resolveOpenAICodexCredential,
    startOpenAICodexCallbackListener,
    type CallbackServerListenOptions,
} from './openai-codex-login.ts'

const base64UrlPattern = /^[A-Za-z0-9_-]+$/

const createAccessToken = (accountId = 'account-id'): string =>
    [
        'header',
        Buffer.from(
            JSON.stringify({
                [OPENAI_CODEX_AUTH_CLAIM]: { chatgpt_account_id: accountId },
            })
        ).toString('base64url'),
        'signature',
    ].join('.')

describe('createOpenAICodexAuthorization', () => {
    test('creates random PKCE and state values for each authorization request', () => {
        const first = createOpenAICodexAuthorization()
        const second = createOpenAICodexAuthorization()

        assert.match(first.codeVerifier, base64UrlPattern)
        assert.match(first.state, base64UrlPattern)
        assert.notEqual(first.codeVerifier, first.state)
        assert.notEqual(first.codeVerifier, second.codeVerifier)
        assert.notEqual(first.state, second.state)
    })

    test('builds the OpenAI Codex authorization URL with an S256 challenge', () => {
        const authorization = createOpenAICodexAuthorization()
        const authorizationUrl = new URL(authorization.authorizationUrl)
        const expectedChallenge = createHash('sha256')
            .update(authorization.codeVerifier, 'utf8')
            .digest('base64url')

        assert.equal(authorizationUrl.origin, 'https://auth.openai.com')
        assert.equal(authorizationUrl.pathname, '/oauth/authorize')
        assert.deepEqual(Object.fromEntries(authorizationUrl.searchParams), {
            response_type: 'code',
            client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
            redirect_uri: 'http://localhost:1455/auth/callback',
            scope: 'openid profile email offline_access',
            code_challenge: expectedChallenge,
            code_challenge_method: 'S256',
            state: authorization.state,
            id_token_add_organizations: 'true',
            codex_cli_simplified_flow: 'true',
            originator: 'yo',
        })
        assert.equal(authorizationUrl.searchParams.has('code_verifier'), false)
        assert.equal(authorizationUrl.searchParams.has('access_token'), false)
        assert.equal(authorizationUrl.searchParams.has('refresh_token'), false)
        assert.equal(authorization.authorizationUrl.includes(authorization.codeVerifier), false)
    })
})

describe('startOpenAICodexCallbackListener', () => {
    test('binds only to the fixed loopback address and accepts a callback with the expected state', async () => {
        let listenOptions: CallbackServerListenOptions | undefined
        let closeCount = 0
        const listener = await startOpenAICodexCallbackListener({
            expectedState: 'expected-state',
            listen: async (options) => {
                listenOptions = options
                return {
                    close: async () => {
                        closeCount += 1
                    },
                }
            },
        })

        assert.equal(listenOptions?.host, '127.0.0.1')
        assert.equal(listenOptions?.port, 1455)
        assert.deepEqual(listenOptions?.onRequest({ requestUrl: '/not-a-callback' }), {
            statusCode: 404,
        })
        assert.deepEqual(
            listenOptions?.onRequest({
                requestUrl: '/auth/callback?code=authorization-code&state=expected-state',
            }),
            { statusCode: 204 }
        )

        assert.deepEqual(await listener.waitForCallback(), {
            status: 'accepted',
            code: 'authorization-code',
        })

        await listener.close()
        await listener.close()

        assert.equal(closeCount, 1)
    })

    test('rejects missing authorization codes and state mismatches', async (context) => {
        const cases = [
            {
                name: 'missing code',
                requestUrl: '/auth/callback?state=expected-state',
                reason: 'missing_code',
            },
            {
                name: 'state mismatch',
                requestUrl: '/auth/callback?code=authorization-code&state=wrong-state',
                reason: 'state_mismatch',
            },
        ] as const

        for (const testCase of cases) {
            await context.test(testCase.name, async () => {
                let listenOptions: CallbackServerListenOptions | undefined
                const listener = await startOpenAICodexCallbackListener({
                    expectedState: 'expected-state',
                    listen: async (options) => {
                        listenOptions = options
                        return { close: async () => {} }
                    },
                })

                assert.deepEqual(listenOptions?.onRequest({ requestUrl: testCase.requestUrl }), {
                    statusCode: 400,
                })
                assert.deepEqual(await listener.waitForCallback(), {
                    status: 'rejected',
                    reason: testCase.reason,
                })
            })
        }
    })

    test('settles a pending callback wait when the listener closes', async () => {
        const listener = await startOpenAICodexCallbackListener({
            expectedState: 'expected-state',
            listen: async () => ({
                close: async () => {},
            }),
        })

        await listener.close()

        assert.equal(await listener.waitForCallback(), null)
    })
})

describe('exchangeOpenAICodexAuthorizationCode', () => {
    test('posts the PKCE authorization-code grant and returns a credential', async () => {
        let request: { input: string; init: RequestInit | undefined } | undefined

        const credential = await exchangeOpenAICodexAuthorizationCode({
            code: 'private-authorization-code',
            codeVerifier: 'private-verifier',
            now: () => 1_700_000_000_000,
            fetch: async (input, init) => {
                request = { input: input.toString(), init }
                return new Response(
                    JSON.stringify({
                        access_token: createAccessToken(),
                        refresh_token: 'private-refresh-token',
                        expires_in: 3_600,
                    }),
                    { status: 200 }
                )
            },
        })

        assert.equal(request?.input, 'https://auth.openai.com/oauth/token')
        assert.equal(request?.init?.method, 'POST')
        assert.deepEqual(request?.init?.headers, {
            'content-type': 'application/x-www-form-urlencoded',
        })
        assert.deepEqual(Object.fromEntries(new URLSearchParams(request?.init?.body?.toString())), {
            grant_type: 'authorization_code',
            client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
            code: 'private-authorization-code',
            code_verifier: 'private-verifier',
            redirect_uri: 'http://localhost:1455/auth/callback',
        })
        assert.deepEqual(credential, {
            type: 'oauth',
            accessToken: createAccessToken(),
            refreshToken: 'private-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'account-id',
        })
    })

    test('rejects unsuccessful and malformed token responses without exposing their contents', async (context) => {
        const cases = [
            {
                name: 'unsuccessful response',
                response: new Response('private failure details', { status: 401 }),
            },
            {
                name: 'missing token fields',
                response: new Response(JSON.stringify({ expires_in: 3_600 }), { status: 200 }),
            },
            {
                name: 'missing account id',
                response: new Response(
                    JSON.stringify({
                        access_token: 'not-a-jwt',
                        refresh_token: 'private-refresh-token',
                        expires_in: 3_600,
                    }),
                    { status: 200 }
                ),
            },
            {
                name: 'empty account id',
                response: new Response(
                    JSON.stringify({
                        access_token: createAccessToken(''),
                        refresh_token: 'private-refresh-token',
                        expires_in: 3_600,
                    }),
                    { status: 200 }
                ),
            },
            {
                name: 'invalid expiry',
                response: new Response(
                    JSON.stringify({
                        access_token: createAccessToken(),
                        refresh_token: 'private-refresh-token',
                        expires_in: 0,
                    }),
                    { status: 200 }
                ),
            },
            {
                name: 'fractional expiry',
                response: new Response(
                    JSON.stringify({
                        access_token: createAccessToken(),
                        refresh_token: 'private-refresh-token',
                        expires_in: 3_600.5,
                    }),
                    { status: 200 }
                ),
            },
        ] as const

        for (const testCase of cases) {
            await context.test(testCase.name, async () => {
                await assert.rejects(
                    exchangeOpenAICodexAuthorizationCode({
                        code: 'private-authorization-code',
                        codeVerifier: 'private-verifier',
                        fetch: async () => testCase.response,
                    }),
                    new Error('OAuth credential exchange failed')
                )
            })
        }
    })
})

describe('refreshOpenAICodexCredential', () => {
    test('posts the refresh-token grant and returns the rotated credential', async () => {
        let request: { input: string; init: RequestInit | undefined } | undefined

        const credential = await refreshOpenAICodexCredential({
            refreshToken: 'private-current-refresh-token',
            now: () => 1_700_000_000_000,
            fetch: async (input, init) => {
                request = { input: input.toString(), init }
                return new Response(
                    JSON.stringify({
                        access_token: createAccessToken('refreshed-account-id'),
                        refresh_token: 'private-rotated-refresh-token',
                        expires_in: 3_600,
                    }),
                    { status: 200 }
                )
            },
        })

        assert.equal(request?.input, 'https://auth.openai.com/oauth/token')
        assert.equal(request?.init?.method, 'POST')
        assert.deepEqual(request?.init?.headers, {
            'content-type': 'application/x-www-form-urlencoded',
        })
        assert.deepEqual(Object.fromEntries(new URLSearchParams(request?.init?.body?.toString())), {
            grant_type: 'refresh_token',
            refresh_token: 'private-current-refresh-token',
            client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        })
        assert.deepEqual(credential, {
            type: 'oauth',
            accessToken: createAccessToken('refreshed-account-id'),
            refreshToken: 'private-rotated-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'refreshed-account-id',
        })
    })

    test('sanitizes network, HTTP, and malformed refresh failures', async (context) => {
        const currentRefreshToken = 'private-current-refresh-token'
        const cases = [
            {
                name: 'network failure',
                privateDetail: 'private-network-failure',
                fetch: async (): Promise<Response> => {
                    throw new Error('private-network-failure')
                },
            },
            {
                name: 'unsuccessful response',
                privateDetail: 'private-response-details',
                fetch: async () =>
                    new Response('private-response-details', {
                        status: 401,
                    }),
            },
            {
                name: 'malformed response',
                privateDetail: 'private-malformed-response',
                fetch: async () => new Response('private-malformed-response', { status: 200 }),
            },
            {
                name: 'missing token fields',
                privateDetail: 'private-missing-token-fields',
                fetch: async () =>
                    new Response(
                        JSON.stringify({
                            error: 'private-missing-token-fields',
                        }),
                        { status: 200 }
                    ),
            },
            {
                name: 'missing account id',
                privateDetail: 'private-invalid-access-token',
                fetch: async () =>
                    new Response(
                        JSON.stringify({
                            access_token: 'private-invalid-access-token',
                            refresh_token: 'private-rotated-refresh-token',
                            expires_in: 3_600,
                        }),
                        { status: 200 }
                    ),
            },
        ] as const

        for (const testCase of cases) {
            await context.test(testCase.name, async () => {
                await assert.rejects(
                    refreshOpenAICodexCredential({
                        refreshToken: currentRefreshToken,
                        fetch: testCase.fetch,
                    }),
                    (error: unknown) => {
                        assert.ok(error instanceof Error)
                        assert.equal(
                            error.message,
                            'OAuth credential refresh failed. Run yo login again.'
                        )
                        assert.equal(error.message.includes(currentRefreshToken), false)
                        assert.equal(error.message.includes(testCase.privateDetail), false)

                        return true
                    }
                )
            })
        }
    })
})

describe('resolveOpenAICodexCredential', () => {
    test('returns undefined without locking or refreshing when no credential is stored', async () => {
        const credentialStore: CredentialStore = {
            read: async (providerId) => {
                assert.equal(providerId, 'openai-codex')
                return undefined
            },
            modify: async () => {
                throw new Error('modify must not run')
            },
            delete: async () => {},
        }

        const resolved = await resolveOpenAICodexCredential({
            credentialStore,
            refreshCredential: async () => {
                throw new Error('refresh must not run')
            },
        })

        assert.equal(resolved, undefined)
    })

    test('returns a valid credential without locking or refreshing', async () => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-access-token',
            refreshToken: 'private-refresh-token',
            expiresAt: 1_001,
            accountId: 'account-id',
        } as const satisfies Credential
        const credentialStore: CredentialStore = {
            read: async () => credential,
            modify: async () => {
                throw new Error('modify must not run')
            },
            delete: async () => {},
        }

        const resolved = await resolveOpenAICodexCredential({
            credentialStore,
            refreshCredential: async () => {
                throw new Error('refresh must not run')
            },
            now: () => 1_000,
        })

        assert.equal(resolved, credential)
    })

    test('refreshes at expiry and persists the rotated credential before returning', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-refresh-'))
        const authPath = join(fixtureRoot, '.yo', 'auth.json')
        const credentialStore = createFileCredentialStore({ authPath })
        const expiredCredential = {
            type: 'oauth',
            accessToken: 'private-expired-access-token',
            refreshToken: 'private-current-refresh-token',
            expiresAt: 1_000,
            accountId: 'old-account-id',
        } as const satisfies Credential
        const refreshedCredential = {
            type: 'oauth',
            accessToken: createAccessToken('refreshed-account-id'),
            refreshToken: 'private-rotated-refresh-token',
            expiresAt: 3_601_000,
            accountId: 'refreshed-account-id',
        } as const satisfies Credential

        try {
            await credentialStore.modify('openai-codex', async () => expiredCredential)

            const resolved = await resolveOpenAICodexCredential({
                credentialStore,
                now: () => 1_000,
                refreshCredential: async ({ refreshToken }) => {
                    assert.equal(refreshToken, expiredCredential.refreshToken)
                    return refreshedCredential
                },
            })

            assert.deepEqual(resolved, refreshedCredential)
            assert.deepEqual(await credentialStore.read('openai-codex'), refreshedCredential)
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true })
        }
    })

    test('preserves the stored credential and requires login when refresh fails', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-refresh-failure-'))
        const authPath = join(fixtureRoot, '.yo', 'auth.json')
        const credentialStore = createFileCredentialStore({ authPath })
        const expiredCredential = {
            type: 'oauth',
            accessToken: 'private-expired-access-token',
            refreshToken: 'private-current-refresh-token',
            expiresAt: 1_000,
            accountId: 'account-id',
        } as const satisfies Credential

        try {
            await credentialStore.modify('openai-codex', async () => expiredCredential)

            await assert.rejects(
                resolveOpenAICodexCredential({
                    credentialStore,
                    now: () => 1_000,
                    refreshCredential: async () => {
                        throw new Error('invalid_grant with private-current-refresh-token')
                    },
                }),
                new Error('OAuth credential refresh failed. Run yo login again.')
            )
            assert.deepEqual(await credentialStore.read('openai-codex'), expiredCredential)
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true })
        }
    })

    test('serializes concurrent refreshes and reuses the credential persisted by the winner', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'yo-concurrent-refresh-'))
        const authPath = join(fixtureRoot, '.yo', 'auth.json')
        const fileCredentialStore = createFileCredentialStore({ authPath })
        const expiredCredential = {
            type: 'oauth',
            accessToken: 'private-expired-access-token',
            refreshToken: 'private-current-refresh-token',
            expiresAt: 1_000,
            accountId: 'account-id',
        } as const satisfies Credential
        const refreshedCredential = {
            type: 'oauth',
            accessToken: 'private-refreshed-access-token',
            refreshToken: 'private-rotated-refresh-token',
            expiresAt: 3_601_000,
            accountId: 'account-id',
        } as const satisfies Credential
        let initialReadCount = 0
        let releaseInitialReads: (() => void) | undefined
        const initialReadsComplete = new Promise<void>((resolve) => {
            releaseInitialReads = resolve
        })
        const credentialStore: CredentialStore = {
            read: async (providerId) => {
                const credential = await fileCredentialStore.read(providerId)

                initialReadCount += 1
                if (initialReadCount === 2) {
                    releaseInitialReads?.()
                }
                await initialReadsComplete

                return credential
            },
            modify: fileCredentialStore.modify,
            delete: fileCredentialStore.delete,
        }
        let refreshCount = 0

        try {
            await fileCredentialStore.modify('openai-codex', async () => expiredCredential)

            const resolveCredential = () =>
                resolveOpenAICodexCredential({
                    credentialStore,
                    now: () => 1_000,
                    refreshCredential: async () => {
                        refreshCount += 1
                        return refreshedCredential
                    },
                })
            const resolved = await Promise.all([resolveCredential(), resolveCredential()])

            assert.deepEqual(resolved, [refreshedCredential, refreshedCredential])
            assert.equal(refreshCount, 1)
            assert.deepEqual(await fileCredentialStore.read('openai-codex'), refreshedCredential)
        } finally {
            await rm(fixtureRoot, { recursive: true, force: true })
        }
    })
})
