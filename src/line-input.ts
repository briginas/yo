import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

export const CHAT_PROMPT = 'yo> '

export class LineReadAbortedError extends Error {
    constructor() {
        super('Line read cancelled')
        this.name = 'LineReadAbortedError'
    }
}

export type LineReadOptions = Readonly<{ signal?: AbortSignal }>

export type ChatSubmission = Readonly<{ line: string; windowId: number }>

export type LineInput = {
    readLine: (prompt: string, options?: LineReadOptions) => Promise<string | null>
    readChatSubmission?: (
        prompt: string,
        options?: LineReadOptions
    ) => Promise<ChatSubmission | null>
    subscribeInterrupt?: (listener: () => void) => () => void
    discardUntilNextRead?: () => void
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
    type PendingRead = {
        resolve: (value: ChatSubmission | null) => void
        reject: (error: unknown) => void
        dispose: () => void
    }
    const buffered: ChatSubmission[] = []
    const interrupts = new Set<() => void>()
    let pending: PendingRead | undefined
    let closed = false
    let ended = false
    let discarding = false
    let failure: Error | undefined
    let windowId = 0

    const finish = (owner: PendingRead, value: ChatSubmission | null): void => {
        if (pending !== owner) return
        pending = undefined
        owner.dispose()
        owner.resolve(value)
    }
    const fail = (owner: PendingRead, error: unknown): void => {
        if (pending !== owner) return
        pending = undefined
        owner.dispose()
        owner.reject(error)
    }
    const onLine = (value: string): void => {
        if (closed || discarding) return
        // Arrival identity survives later prompts and dequeue; approval reads do not advance it.
        const submission = Object.freeze({ line: value, windowId })
        buffered.push(submission)
        if (pending !== undefined) finish(pending, buffered.shift()!)
    }
    const clearPartial = (): void => {
        if (ended) return
        // Public readline input simulation clears its partial buffer too, not just our queue.
        if (isInteractive) {
            lines.write(null, { ctrl: true, name: 'u' })
            lines.write(null, { ctrl: true, name: 'k' })
            // TERM=dumb ignores editing keys; Return still flushes the line into discard mode.
            if (lines.line.length > 0) lines.write(null, { name: 'return' })
        } else lines.write('\n')
    }
    const discardUntilNextRead = (): void => {
        if (closed) return
        discarding = true
        buffered.length = 0
        if (pending !== undefined) fail(pending, new LineReadAbortedError())
        try {
            clearPartial()
        } catch {
            onError(new Error('Input reset failed'))
        }
    }
    const detach = (): void => {
        lines.off('line', onLine)
        lines.off('close', onClose)
        lines.off('SIGINT', onInterrupt)
        lines.off('error', onError)
        interrupts.clear()
    }
    const onClose = (): void => {
        ended = true
        detach()
        if (pending !== undefined) finish(pending, null)
    }
    const onError = (error: Error): void => {
        failure = error
        buffered.length = 0
        if (pending !== undefined) fail(pending, error)
        lines.close()
    }
    const onInterrupt = (): void => {
        if (interrupts.size === 0) {
            lines.close()
            return
        }
        for (const listener of [...interrupts]) {
            try {
                listener()
            } catch {
                // Notification observers do not own or invalidate the input reader.
            }
        }
    }
    lines.on('line', onLine)
    lines.on('close', onClose)
    lines.on('error', onError)
    lines.on('SIGINT', onInterrupt)

    const read = (
        prompt: string,
        { signal }: LineReadOptions = {},
        opensChatWindow = false
    ): Promise<ChatSubmission | null> => {
        if (pending !== undefined) return Promise.reject(new Error('Input already has an owner'))
        if (signal?.aborted) return Promise.reject(new LineReadAbortedError())
        if (closed) return Promise.resolve(null)
        if (failure !== undefined) return Promise.reject(failure)
        if (discarding) {
            try {
                clearPartial()
            } catch {
                onError(new Error('Input reset failed'))
                return Promise.reject(failure)
            }
            discarding = false
        }
        if (ended && buffered.length === 0) return Promise.resolve(null)
        if (opensChatWindow && windowId === Number.MAX_SAFE_INTEGER)
            return Promise.reject(new Error('Input arrival window exhausted'))

        return new Promise((resolve, reject) => {
            const owner: PendingRead = {
                resolve,
                reject,
                dispose: () => signal?.removeEventListener('abort', cancel),
            }
            const cancel = (): void => {
                if (pending !== owner) return
                discardUntilNextRead()
            }
            pending = owner
            signal?.addEventListener('abort', cancel, { once: true })
            try {
                if (opensChatWindow) windowId += 1
                lines.setPrompt(prompt)
                lines.prompt()
                if (pending === owner) {
                    const next = buffered.shift()
                    if (next !== undefined) finish(owner, next)
                }
            } catch (error) {
                fail(owner, error)
            }
        })
    }

    return {
        readLine: (prompt, options): Promise<string | null> =>
            read(prompt, options).then((submission) => submission?.line ?? null),
        readChatSubmission: (prompt, options): Promise<ChatSubmission | null> =>
            read(prompt, options, true),
        discardUntilNextRead,
        subscribeInterrupt: (listener): (() => void) => {
            if (!closed && !ended) interrupts.add(listener)
            return () => interrupts.delete(listener)
        },
        close: (): void => {
            if (closed) {
                return
            }

            closed = true
            buffered.length = 0
            if (pending !== undefined) finish(pending, null)
            lines.close()
            detach()
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
