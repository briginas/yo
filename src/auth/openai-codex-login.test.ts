import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import {
    createOpenAICodexAuthorization,
    exchangeOpenAICodexAuthorizationCode,
    OPENAI_CODEX_AUTH_CLAIM,
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
