#!/usr/bin/env node

import { createFileCredentialStore } from './auth/file-credential-store.ts'
import { runCli } from './cli-app.ts'
import { createOpenAICodexResponsesTransport } from './provider/openai-codex-responses.ts'

const credentialStore = createFileCredentialStore()
const result = await runCli(process.argv.slice(2), {
    transport: createOpenAICodexResponsesTransport({ credentialStore }),
    credentialStore,
    writeOutput: (message) => process.stdout.write(`${message}\n`),
    writeError: (message) => process.stderr.write(`${message}\n`),
})

process.exitCode = result.exitCode
