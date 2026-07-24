import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const SCOPE = 'openid profile email offline_access'

export type OpenAICodexAuthorization = {
    authorizationUrl: string
    codeVerifier: string
    state: string
}

type CallbackRequest = {
    requestUrl: string
}

type CallbackRequestResult = {
    statusCode: number
}

type CallbackServer = {
    close: () => Promise<void>
}

export type CallbackServerListenOptions = {
    host: string
    port: number
    onRequest: (request: CallbackRequest) => CallbackRequestResult
}

export type CallbackServerListener = (
    options: CallbackServerListenOptions
) => Promise<CallbackServer>

export type OpenAICodexCallbackListener = {
    waitForCallback: () => Promise<OpenAICodexCallbackOutcome | null>
    close: () => Promise<void>
}

export type OpenAICodexCallbackOutcome =
    | {
          status: 'accepted'
          code: string
      }
    | {
          status: 'rejected'
          reason: 'missing_code' | 'state_mismatch'
      }

export type OpenAICodexCallbackListenerOptions = {
    expectedState: string
    listen?: CallbackServerListener
}

const createRandomBase64Url = (): string => randomBytes(32).toString('base64url')

const createPkce = (): { verifier: string; challenge: string } => {
    const verifier = createRandomBase64Url()
    const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')

    return { verifier, challenge }
}

export const createOpenAICodexAuthorization = (): OpenAICodexAuthorization => {
    const { verifier, challenge } = createPkce()
    const state = createRandomBase64Url()
    const authorizationUrl = new URL(AUTHORIZE_URL)

    authorizationUrl.searchParams.set('response_type', 'code')
    authorizationUrl.searchParams.set('client_id', CLIENT_ID)
    authorizationUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authorizationUrl.searchParams.set('scope', SCOPE)
    authorizationUrl.searchParams.set('code_challenge', challenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('id_token_add_organizations', 'true')
    authorizationUrl.searchParams.set('codex_cli_simplified_flow', 'true')
    authorizationUrl.searchParams.set('originator', 'yo')

    return {
        authorizationUrl: authorizationUrl.toString(),
        codeVerifier: verifier,
        state,
    }
}

const listenWithNodeHttp: CallbackServerListener = ({ host, port, onRequest }) =>
    new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
            const result = onRequest({ requestUrl: request.url ?? '/' })

            response.statusCode = result.statusCode
            response.end()
        })
        const handleStartupError = (error: Error): void => {
            reject(error)
        }

        server.once('error', handleStartupError)
        server.listen(port, host, () => {
            server.off('error', handleStartupError)
            resolve({
                close: () =>
                    new Promise<void>((resolveClose, rejectClose) => {
                        server.close((error) => {
                            if (error !== undefined) {
                                rejectClose(error)
                                return
                            }

                            resolveClose()
                        })
                    }),
            })
        })
    })

export const startOpenAICodexCallbackListener = async ({
    expectedState,
    listen = listenWithNodeHttp,
}: OpenAICodexCallbackListenerOptions): Promise<OpenAICodexCallbackListener> => {
    let resolveCallback: ((outcome: OpenAICodexCallbackOutcome | null) => void) | undefined
    let callbackSettled = false
    const callbackPromise = new Promise<OpenAICodexCallbackOutcome | null>((resolve) => {
        resolveCallback = resolve
    })
    const settleCallback = (outcome: OpenAICodexCallbackOutcome | null): void => {
        if (callbackSettled) {
            return
        }

        callbackSettled = true
        resolveCallback?.(outcome)
    }
    const server = await listen({
        host: CALLBACK_HOST,
        port: CALLBACK_PORT,
        onRequest: ({ requestUrl }) => {
            const callbackUrl = new URL(requestUrl, REDIRECT_URI)

            if (callbackUrl.pathname !== CALLBACK_PATH) {
                return { statusCode: 404 }
            }

            const code = callbackUrl.searchParams.get('code')

            if (code === null || code.length === 0) {
                settleCallback({ status: 'rejected', reason: 'missing_code' })
                return { statusCode: 400 }
            }

            if (callbackUrl.searchParams.get('state') !== expectedState) {
                settleCallback({ status: 'rejected', reason: 'state_mismatch' })
                return { statusCode: 400 }
            }

            settleCallback({ status: 'accepted', code })
            return { statusCode: 204 }
        },
    })
    let closePromise: Promise<void> | undefined

    return {
        waitForCallback: () => callbackPromise,
        close: () => {
            if (closePromise === undefined) {
                settleCallback(null)
                closePromise = server.close()
            }

            return closePromise
        },
    }
}
