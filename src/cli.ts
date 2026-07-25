#!/usr/bin/env node

import { createFileCredentialStore } from './auth/file-credential-store.ts'
import { runCli } from './cli-app.ts'
import { createNodeLineInput } from './line-input.ts'
import { createOpenAICodexResponsesTransport } from './provider/openai-codex-responses.ts'

const credentialStore = createFileCredentialStore()
const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY)
const result = await runCli(process.argv.slice(2), {
    transport: createOpenAICodexResponsesTransport({ credentialStore }),
    credentialStore,
    writeOutput: (message) => process.stdout.write(`${message}\n`),
    writeError: (message) => process.stderr.write(`${message}\n`),
    createLineInput: () =>
        createNodeLineInput({
            input: process.stdin,
            output: process.stdout,
            isInteractive,
        }),
    writeAnswer: (message) => process.stdout.write(message),
    writeStatus: (message) => process.stderr.write(message),
    clearStatusLine: () => process.stderr.clearLine(0),
    moveStatusCursorToStart: () => process.stderr.cursorTo(0),
    isInteractive,
})

process.exitCode = result.exitCode
