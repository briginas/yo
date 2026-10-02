export type ObservationCommand =
    { type: 'list' } | { type: 'inspect'; id: number } | { type: 'invalid' } | { type: 'message' }

export const parseObservationCommand = (line: string): ObservationCommand => {
    const [command, ...args] = line.trim().split(/[ \t]+/)
    if (command !== '/runs' && command !== '/run') return { type: 'message' }
    if (command === '/runs') return { type: args.length === 0 ? 'list' : 'invalid' }
    const value = args[0]
    if (args.length !== 1 || value === undefined || !/^[1-9][0-9]*$/.test(value)) {
        return { type: 'invalid' }
    }
    const id = Number(value)
    return Number.isSafeInteger(id) ? { type: 'inspect', id } : { type: 'invalid' }
}
