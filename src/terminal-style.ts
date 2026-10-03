export type TerminalTextFormatter = (message: string) => string

export type TerminalTechnicalStyleOptions = {
    isInteractive: boolean
    noColor?: string | undefined
    term?: string | undefined
}

export const plainTerminalText: TerminalTextFormatter = (message) => message

export const createTerminalTechnicalFormatter = ({
    isInteractive,
    noColor,
    term,
}: TerminalTechnicalStyleOptions): TerminalTextFormatter => {
    if (!isInteractive || (noColor !== undefined && noColor !== '') || term === 'dumb') {
        return plainTerminalText
    }

    // Reset intensity per write so answers, patch review, and input never inherit dim.
    return (message) => (message.length === 0 ? message : `\u001b[2m${message}\u001b[22m`)
}
