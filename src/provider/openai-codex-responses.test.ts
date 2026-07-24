import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { Credential, CredentialStore } from '../auth/credential.ts'
import { sendOpenAICodexResponsesRequest } from './openai-codex-responses.ts'

const unusedCredentialStore: CredentialStore = {
    read: async () => {
        throw new Error('read must not run')
    },
    modify: async () => {
        throw new Error('modify must not run')
    },
    delete: async () => {
        throw new Error('delete must not run')
    },
}

describe('sendOpenAICodexResponsesRequest', () => {
    test('sends the prepared JSON body with the resolved OAuth credential', async () => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-refreshed-access-token',
            refreshToken: 'private-rotated-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'refreshed-account-id',
        } as const satisfies Credential
        const body = {
            model: 'test-model',
            stream: true,
            input: [{ role: 'user', content: 'Inspect the workspace.' }],
        } as const
        const expectedResponse = new Response('data: response.created\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        })
        let request:
            | {
                  input: string
                  init: RequestInit | undefined
              }
            | undefined

        const response = await sendOpenAICodexResponsesRequest({
            body,
            credentialStore: unusedCredentialStore,
            resolveCredential: async ({ credentialStore }) => {
                assert.equal(credentialStore, unusedCredentialStore)
                return credential
            },
            fetch: async (input, init) => {
                request = { input: input.toString(), init }
                return expectedResponse
            },
        })

        assert.equal(request?.input, 'https://chatgpt.com/backend-api/codex/responses')
        assert.equal(request?.init?.method, 'POST')
        assert.equal(request?.init?.body, JSON.stringify(body))

        const headers = new Headers(request?.init?.headers)

        assert.equal(headers.get('authorization'), `Bearer ${credential.accessToken}`)
        assert.equal(headers.get('chatgpt-account-id'), credential.accountId)
        assert.equal(headers.get('originator'), 'yo')
        assert.equal(headers.get('openai-beta'), 'responses=experimental')
        assert.equal(headers.get('accept'), 'text/event-stream')
        assert.equal(headers.get('content-type'), 'application/json')
        assert.equal(headers.has('x-api-key'), false)

        const transmittedRequest = JSON.stringify({
            headers: Object.fromEntries(headers),
            body: request?.init?.body,
        })

        assert.equal(transmittedRequest.includes(credential.refreshToken), false)
        assert.equal(transmittedRequest.includes(credential.expiresAt.toString()), false)
        assert.equal(response, expectedResponse)
        assert.equal(response.bodyUsed, false)
    })

    test('returns an unsuccessful HTTP response without reading its body', async () => {
        const credential = {
            type: 'oauth',
            accessToken: 'private-access-token',
            refreshToken: 'private-refresh-token',
            expiresAt: 1_700_003_600_000,
            accountId: 'account-id',
        } as const satisfies Credential
        const expectedResponse = new Response(
            JSON.stringify({
                error: {
                    code: 'unauthorized',
                    message: 'private-provider-response',
                },
            }),
            {
                status: 401,
                headers: { 'content-type': 'application/json' },
            }
        )

        const response = await sendOpenAICodexResponsesRequest({
            body: { stream: true },
            credentialStore: unusedCredentialStore,
            resolveCredential: async () => credential,
            fetch: async () => expectedResponse,
        })

        assert.equal(response, expectedResponse)
        assert.equal(response.status, 401)
        assert.equal(response.bodyUsed, false)
    })

    test('requires login without sending a request when no credential is stored', async () => {
        let requestCount = 0

        await assert.rejects(
            sendOpenAICodexResponsesRequest({
                body: { stream: true },
                credentialStore: unusedCredentialStore,
                resolveCredential: async () => undefined,
                fetch: async () => {
                    requestCount += 1
                    return new Response()
                },
            }),
            (error: unknown) => {
                assert.equal(
                    error instanceof Error ? error.message : undefined,
                    'OpenAI Codex authentication is required. Run yo login.'
                )
                assert.equal(String(error).includes('private-access-token'), false)
                assert.equal(String(error).includes('private-refresh-token'), false)
                return true
            }
        )

        assert.equal(requestCount, 0)
    })
})
