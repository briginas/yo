#!/usr/bin/env node

import { runCli } from './cli-app.ts'

const result = await runCli(process.argv.slice(2), {
    transport: null,
    writeError: (message) => process.stderr.write(`${message}\n`),
})

process.exitCode = result.exitCode
