import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import lockfile from 'proper-lockfile'
import { z } from 'zod'

import {
    credentialSchema,
    OPENAI_CODEX_PROVIDER_ID,
    type Credential,
    type CredentialProviderId,
    type CredentialStore,
} from './credential.ts'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

const credentialStoreFileSchema = z
    .object({
        [OPENAI_CODEX_PROVIDER_ID]: credentialSchema.optional(),
    })
    .strict()

type CredentialStoreFile = z.infer<typeof credentialStoreFileSchema>

export type FileCredentialStoreOptions = {
    authPath?: string
}

const isMissingPathError = (error: unknown): boolean =>
    error instanceof Error && 'code' in error && error.code === 'ENOENT'

const ensureParentDirectory = async (authPath: string): Promise<void> => {
    const directoryPath = dirname(authPath)

    await mkdir(directoryPath, { recursive: true, mode: DIRECTORY_MODE })
    await chmod(directoryPath, DIRECTORY_MODE)
}

const ensureCredentialFileMode = async (authPath: string): Promise<boolean> => {
    try {
        const stats = await lstat(authPath)

        if (!stats.isFile()) {
            throw new Error('OAuth credential store must be a regular file')
        }

        await chmod(authPath, FILE_MODE)
        return true
    } catch (error) {
        if (isMissingPathError(error)) {
            return false
        }

        throw error
    }
}

const parseCredentialStoreFile = (content: string): CredentialStoreFile => {
    try {
        return credentialStoreFileSchema.parse(JSON.parse(content))
    } catch {
        // Parsing errors are intentionally sanitized because the file contains secrets.
        throw new Error('OAuth credential store is malformed')
    }
}

const readCredentialStoreFile = async (authPath: string): Promise<CredentialStoreFile> => {
    if (!(await ensureCredentialFileMode(authPath))) {
        return {}
    }

    try {
        return parseCredentialStoreFile(await readFile(authPath, 'utf8'))
    } catch (error) {
        if (isMissingPathError(error)) {
            return {}
        }

        throw error
    }
}

const writeCredentialStoreFile = async (
    authPath: string,
    data: CredentialStoreFile,
    assertLockHeld: () => void
): Promise<void> => {
    const temporaryPath = join(
        dirname(authPath),
        `.${basename(authPath)}.${process.pid}.${randomUUID()}.tmp`
    )
    const content = `${JSON.stringify(data, null, 2)}\n`
    let temporaryFile: Awaited<ReturnType<typeof open>> | undefined

    try {
        temporaryFile = await open(temporaryPath, 'wx', FILE_MODE)
        await temporaryFile.writeFile(content, 'utf8')
        await temporaryFile.sync()
        await temporaryFile.close()
        temporaryFile = undefined

        assertLockHeld()
        await rename(temporaryPath, authPath)
        await chmod(authPath, FILE_MODE)
    } finally {
        await temporaryFile?.close().catch(() => {})
        await rm(temporaryPath, { force: true }).catch(() => {})
    }
}

const withCredentialStoreLock = async <T>(
    authPath: string,
    operation: (assertLockHeld: () => void) => Promise<T>
): Promise<T> => {
    await ensureParentDirectory(authPath)

    let compromisedError: Error | undefined
    const release = await lockfile.lock(authPath, {
        realpath: false,
        retries: {
            retries: 10,
            factor: 2,
            minTimeout: 100,
            maxTimeout: 10_000,
            randomize: true,
        },
        stale: 30_000,
        onCompromised: (error) => {
            compromisedError = error
        },
    })
    const assertLockHeld = () => {
        if (compromisedError !== undefined) {
            throw new Error('OAuth credential store lock was compromised')
        }
    }
    let operationError: unknown

    try {
        assertLockHeld()
        const result = await operation(assertLockHeld)
        assertLockHeld()
        return result
    } catch (error) {
        operationError = error
        throw error
    } finally {
        try {
            await release()
        } catch (releaseError) {
            if (operationError === undefined && compromisedError === undefined) {
                throw releaseError
            }
        }
    }
}

export const createFileCredentialStore = ({
    authPath = join(homedir(), '.yo', 'auth.json'),
}: FileCredentialStoreOptions = {}): CredentialStore => ({
    read: async (providerId: CredentialProviderId): Promise<Credential | undefined> => {
        await ensureParentDirectory(authPath)
        const data = await readCredentialStoreFile(authPath)
        return data[providerId]
    },
    modify: async (
        providerId: CredentialProviderId,
        update: (current: Credential | undefined) => Promise<Credential | undefined>
    ): Promise<Credential | undefined> =>
        withCredentialStoreLock(authPath, async (assertLockHeld) => {
            const data = await readCredentialStoreFile(authPath)
            const current = data[providerId]
            const next = await update(current)

            assertLockHeld()
            if (next === undefined) {
                return current
            }

            await writeCredentialStoreFile(authPath, { [providerId]: next }, assertLockHeld)
            return next
        }),
    delete: async (providerId: CredentialProviderId): Promise<void> => {
        await withCredentialStoreLock(authPath, async (assertLockHeld) => {
            const data = await readCredentialStoreFile(authPath)

            delete data[providerId]
            await writeCredentialStoreFile(authPath, data, assertLockHeld)
        })
    },
})
