import { z } from 'zod'

// Single source of truth for the credential store key and provider id.
export const OPENAI_CODEX_PROVIDER_ID = 'openai-codex'

export const credentialProviderIdSchema = z.literal(OPENAI_CODEX_PROVIDER_ID)

export type CredentialProviderId = z.infer<typeof credentialProviderIdSchema>

export const openAICodexOAuthCredentialSchema = z
    .object({
        type: z.literal('oauth'),
        accessToken: z.string().min(1),
        refreshToken: z.string().min(1),
        expiresAt: z.number().int().nonnegative(),
        accountId: z.string().min(1),
    })
    .strict()

export type OpenAICodexOAuthCredential = z.infer<typeof openAICodexOAuthCredentialSchema>

export const credentialSchema = openAICodexOAuthCredentialSchema

export type Credential = z.infer<typeof credentialSchema>

export type CredentialStore = {
    read: (providerId: CredentialProviderId) => Promise<Credential | undefined>

    // Persistent implementations must serialize each provider's read-modify-write,
    // including across processes. Returning undefined leaves the current value unchanged.
    modify: (
        providerId: CredentialProviderId,
        update: (current: Credential | undefined) => Promise<Credential | undefined>
    ) => Promise<Credential | undefined>

    // Deletion must be serialized against modify for the same provider.
    delete: (providerId: CredentialProviderId) => Promise<void>
}
