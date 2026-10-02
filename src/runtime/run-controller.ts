export type RunController<Result> = Readonly<{
    signal: AbortSignal
    settled: Promise<Result>
    requestCancellation: () => void
    dispose: () => void
}>

// Trusted callers dispose after settlement. Disposal only closes the request path;
// it cannot stop, detach, or settle the operation whose promise this controller owns.
export const createRunController = <Result>(
    execute: (signal: AbortSignal) => Promise<Result>
): RunController<Result> => {
    const abortController = new AbortController()
    let acceptingRequests = true
    const dispose = (): void => {
        acceptingRequests = false
    }

    // Allow the owner to register this controller before invocation emits synchronous events.
    const settled = Promise.resolve()
        .then(() => execute(abortController.signal))
        .finally(dispose)

    return {
        signal: abortController.signal,
        settled,
        requestCancellation: (): void => {
            if (acceptingRequests && !abortController.signal.aborted) {
                abortController.abort()
            }
        },
        dispose,
    }
}
