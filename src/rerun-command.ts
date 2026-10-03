export type RerunCommand =
    { type: 'rerun'; sourceId: number } | { type: 'invalid' } | { type: 'message' }

export const parseRerunCommand = (line: string): RerunCommand => {
    const [command, ...args] = line.trim().split(/[ \t]+/)
    if (command !== '/rerun') return { type: 'message' }
    const value = args[0]
    if (args.length !== 1 || value === undefined || !/^[1-9][0-9]*$/.test(value)) {
        return { type: 'invalid' }
    }
    const sourceId = Number(value)
    return Number.isSafeInteger(sourceId) ? { type: 'rerun', sourceId } : { type: 'invalid' }
}
