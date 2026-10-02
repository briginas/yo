export class OperationAbortedError extends Error {
    constructor() {
        super('Tool execution was aborted')
        this.name = 'OperationAbortedError'
    }
}

export const checkOperationSignal = (signal?: AbortSignal): void => {
    if (signal?.aborted) {
        // Arbitrary external abort reasons must never become tool output.
        throw new OperationAbortedError()
    }
}

export type SettledOperationOutcome<Value> =
    | Readonly<{ status: 'completed'; result: Value }>
    | Readonly<{ status: 'timeout' }>
    | Readonly<{ status: 'aborted' }>

export const executeSettledOperation = async <Value>(
    execute: (signal: AbortSignal) => Promise<Value>,
    options: Readonly<{ signal?: AbortSignal | undefined; timeoutMs?: number }> = {}
): Promise<SettledOperationOutcome<Value>> => {
    const controller = new AbortController()
    let stopCause: 'timeout' | 'aborted' | undefined
    let committed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const requestStop = (cause: 'timeout' | 'aborted'): void => {
        if (!committed && stopCause === undefined) {
            stopCause = cause
            controller.abort()
        }
    }
    const onAbort = (): void => requestStop('aborted')
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
        if (options.signal?.aborted) {
            requestStop('aborted')
            return { status: 'aborted' }
        }
        if (options.timeoutMs !== undefined) {
            timer = setTimeout(() => requestStop('timeout'), options.timeoutMs)
        }

        try {
            const result = await execute(controller.signal)
            // Commit when the complete operation (including owned cleanup) is observed.
            // Stop requests arriving before this point win; no detached race returns early.
            committed = true
            return stopCause === undefined ? { status: 'completed', result } : { status: stopCause }
        } catch (error) {
            committed = true
            if (stopCause !== undefined) {
                return { status: stopCause }
            }
            throw error
        }
    } finally {
        committed = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
    }
}
