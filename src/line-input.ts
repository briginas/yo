import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export const CHAT_PROMPT = 'yo> '

export type LineInput = {
    readLine: (prompt: string) => Promise<string | null>
    close: () => void
}

export type ChatInputStopReason = 'eof' | 'exit'

export type CreateNodeLineInputOptions = {
    input: Readable
    output: Writable
    isInteractive: boolean
}

export type RunChatInputOptions = {
    input: LineInput
    onMessage: (message: string) => Promise<void>
    clearProgress: () => void
}

export const createNodeLineInput = ({
    input,
    output,
    isInteractive,
}: CreateNodeLineInputOptions): LineInput => {
    const lines = createInterface({
        input,
        output,
        terminal: isInteractive,
    })
    const iterator = lines[Symbol.asyncIterator]()
    let closed = false

    return {
        readLine: async (prompt): Promise<string | null> => {
            if (closed) {
                return null
            }

            lines.setPrompt(prompt)
            lines.prompt()

            const next = await iterator.next()

            if (next.done) {
                closed = true
                return null
            }

            return next.value
        },
        close: (): void => {
            if (closed) {
                return
            }

            closed = true
            lines.close()
        },
    }
}

export const runChatInput = async ({
    input,
    onMessage,
    clearProgress,
}: RunChatInputOptions): Promise<ChatInputStopReason> => {
    try {
        while (true) {
            const line = await input.readLine(CHAT_PROMPT)

            if (line === null) {
                return 'eof'
            }

            if (line === '/exit') {
                return 'exit'
            }

            if (line.trim().length === 0) {
                continue
            }

            await onMessage(line)
        }
    } finally {
        try {
            input.close()
        } finally {
            clearProgress()
        }
    }
}
