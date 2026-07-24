import type { Credential, CredentialStore } from '../auth/credential.ts'
import { resolveOpenAICodexCredential } from '../auth/openai-codex-login.ts'

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

export type OpenAICodexCredentialResolver = (options: {
    credentialStore: CredentialStore
}) => Promise<Credential | undefined>

export type OpenAICodexResponsesRequestOptions = {
    body: Readonly<Record<string, unknown>>
    credentialStore: CredentialStore
    fetch?: typeof globalThis.fetch
    resolveCredential?: OpenAICodexCredentialResolver
}

export const sendOpenAICodexResponsesRequest = async ({
    body,
    credentialStore,
    fetch: sendRequest = globalThis.fetch,
    resolveCredential = resolveOpenAICodexCredential,
}: OpenAICodexResponsesRequestOptions): Promise<Response> => {
    const credential = await resolveCredential({ credentialStore })

    if (credential === undefined) {
        throw new Error('OpenAI Codex authentication is required. Run yo login.')
    }

    return sendRequest(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            'chatgpt-account-id': credential.accountId,
            originator: 'yo',
            'OpenAI-Beta': 'responses=experimental',
            accept: 'text/event-stream',
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    })
}
