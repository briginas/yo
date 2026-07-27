import { createHash } from 'node:crypto'

import { createTwoFilesPatch, diffLines } from 'diff'

import { PATCH_MAX_DIFF_BYTES, PATCH_MAX_FILE_BYTES, type PatchEdit } from './patch-contracts.ts'

export type PatchTransformErrorCode =
    | 'source_too_large'
    | 'invalid_utf8'
    | 'nul_byte'
    | 'duplicate_old_text'
    | 'match_missing'
    | 'match_not_unique'
    | 'overlapping_edits'
    | 'unchanged_output'
    | 'result_too_large'
    | 'display_diff_too_large'
    | 'unified_patch_too_large'

export class PatchTransformError extends Error {
    readonly code: PatchTransformErrorCode

    constructor(code: PatchTransformErrorCode, message: string) {
        super(message)
        this.name = 'PatchTransformError'
        this.code = code
    }
}

export type PatchTransform = Readonly<{
    nextContent: string
    baseHash: string
    nextHash: string
    diff: string
    unifiedPatch: string
    addedLineCount: number
    removedLineCount: number
}>

type LineEnding = '\n' | '\r\n' | '\r'

type MatchedEdit = Readonly<{
    editIndex: number
    start: number
    end: number
    newText: string
}>

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const fail = (code: PatchTransformErrorCode, message: string): never => {
    throw new PatchTransformError(code, message)
}

const hasNul = (value: string): boolean => value.includes('\0')

const hashBytes = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

const normalizeLineEndings = (value: string): string => value.replace(/\r\n|\r/g, '\n')

const restoreLineEndings = (value: string, lineEnding: LineEnding): string =>
    lineEnding === '\n' ? value : value.replace(/\n/g, lineEnding)

const detectDominantLineEnding = (value: string): LineEnding => {
    const counts = new Map<LineEnding, number>([
        ['\r\n', 0],
        ['\n', 0],
        ['\r', 0],
    ])
    const firstSeen: LineEnding[] = []

    for (const match of value.matchAll(/\r\n|\r|\n/g)) {
        const ending = match[0]
        if (ending !== '\r\n' && ending !== '\n' && ending !== '\r') {
            continue
        }
        if (counts.get(ending) === 0) {
            firstSeen.push(ending)
        }
        counts.set(ending, (counts.get(ending) ?? 0) + 1)
    }

    let dominant: LineEnding = '\n'
    let maximum = 0
    for (const ending of firstSeen) {
        const count = counts.get(ending) ?? 0
        if (count > maximum) {
            dominant = ending
            maximum = count
        }
    }

    return dominant
}

const countMatches = (content: string, oldText: string): number[] => {
    const matches: number[] = []
    let nextStart = 0

    while (nextStart <= content.length - oldText.length) {
        const index = content.indexOf(oldText, nextStart)
        if (index === -1) {
            break
        }
        matches.push(index)
        nextStart = index + 1
    }

    return matches
}

const countDiffLines = (
    oldContent: string,
    nextContent: string
): Readonly<{ addedLineCount: number; removedLineCount: number }> => {
    let addedLineCount = 0
    let removedLineCount = 0

    for (const part of diffLines(oldContent, nextContent)) {
        const lineCount =
            part.value.length === 0
                ? 0
                : part.value.split('\n').length - Number(part.value.endsWith('\n'))
        if (part.added) {
            addedLineCount += lineCount
        }
        if (part.removed) {
            removedLineCount += lineCount
        }
    }

    return { addedLineCount, removedLineCount }
}

const createDisplayDiff = (
    relativePath: string,
    oldContent: string,
    nextContent: string
): string => {
    const lines = [`--- ${relativePath}`, `+++ ${relativePath}`]

    for (const part of diffLines(oldContent, nextContent)) {
        if (!part.added && !part.removed) {
            continue
        }
        const prefix = part.added ? '+' : '-'
        const partLines = part.value.split('\n')
        if (partLines[partLines.length - 1] === '') {
            partLines.pop()
        }
        for (const line of partLines) {
            lines.push(`${prefix}${line}`)
        }
    }

    return `${lines.join('\n')}\n`
}

const assertBoundedDiff = (
    value: string,
    code: Extract<PatchTransformErrorCode, 'display_diff_too_large' | 'unified_patch_too_large'>
): void => {
    if (Buffer.byteLength(value, 'utf8') > PATCH_MAX_DIFF_BYTES) {
        fail(code, `Patch preview must not exceed ${PATCH_MAX_DIFF_BYTES} UTF-8 bytes`)
    }
}

export const preparePatchTransform = (
    sourceBytes: Uint8Array,
    relativePath: string,
    edits: readonly PatchEdit[]
): PatchTransform => {
    if (sourceBytes.byteLength > PATCH_MAX_FILE_BYTES) {
        fail('source_too_large', `Source file must not exceed ${PATCH_MAX_FILE_BYTES} bytes`)
    }

    let sourceContent = ''
    try {
        sourceContent = textDecoder.decode(sourceBytes)
    } catch {
        fail('invalid_utf8', 'Source file must be valid UTF-8 text')
    }

    if (
        hasNul(sourceContent) ||
        edits.some((edit) => hasNul(edit.oldText) || hasNul(edit.newText))
    ) {
        fail('nul_byte', 'Patch source and edits must not contain NUL bytes')
    }

    const bom = sourceContent.startsWith('\uFEFF') ? '\uFEFF' : ''
    const sourceWithoutBom = sourceContent.slice(bom.length)
    const lineEnding = detectDominantLineEnding(sourceWithoutBom)
    const normalizedSource = normalizeLineEndings(sourceWithoutBom)
    const normalizedEdits = edits.map((edit) => ({
        oldText: normalizeLineEndings(edit.oldText),
        newText: normalizeLineEndings(edit.newText),
    }))
    const seenOldTexts = new Set<string>()
    for (const [editIndex, edit] of normalizedEdits.entries()) {
        if (seenOldTexts.has(edit.oldText)) {
            fail('duplicate_old_text', `edits[${editIndex}].oldText duplicates an earlier edit`)
        }
        seenOldTexts.add(edit.oldText)
    }

    const matches: MatchedEdit[] = []

    for (const [editIndex, edit] of normalizedEdits.entries()) {
        const positions = countMatches(normalizedSource, edit.oldText)
        if (positions.length === 0) {
            fail('match_missing', `edits[${editIndex}].oldText does not occur in the source`)
        }
        if (positions.length > 1) {
            fail(
                'match_not_unique',
                `edits[${editIndex}].oldText must occur exactly once in the source`
            )
        }
        const [start] = positions
        if (start === undefined) {
            return fail('match_missing', `edits[${editIndex}].oldText does not occur in the source`)
        }
        matches.push({
            editIndex,
            start,
            end: start + edit.oldText.length,
            newText: edit.newText,
        })
    }

    matches.sort((left, right) => left.start - right.start)
    for (let index = 1; index < matches.length; index += 1) {
        const previous = matches[index - 1]
        const current = matches[index]
        if (previous === undefined || current === undefined) {
            continue
        }
        if (previous.end > current.start) {
            fail(
                'overlapping_edits',
                `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${relativePath}`
            )
        }
    }

    let normalizedNext = normalizedSource
    for (const match of [...matches].reverse()) {
        normalizedNext =
            normalizedNext.slice(0, match.start) + match.newText + normalizedNext.slice(match.end)
    }

    if (normalizedNext === normalizedSource) {
        fail('unchanged_output', 'Patch replacements do not change the source')
    }

    const nextContent = `${bom}${restoreLineEndings(normalizedNext, lineEnding)}`
    const nextBytes = Buffer.from(nextContent, 'utf8')
    if (nextBytes.byteLength > PATCH_MAX_FILE_BYTES) {
        fail('result_too_large', `Patch result must not exceed ${PATCH_MAX_FILE_BYTES} bytes`)
    }

    const diff = createDisplayDiff(relativePath, normalizedSource, normalizedNext)
    assertBoundedDiff(diff, 'display_diff_too_large')

    const unifiedPatch = createTwoFilesPatch(
        relativePath,
        relativePath,
        normalizedSource,
        normalizedNext
    )
    assertBoundedDiff(unifiedPatch, 'unified_patch_too_large')

    const { addedLineCount, removedLineCount } = countDiffLines(normalizedSource, normalizedNext)
    return {
        nextContent,
        baseHash: hashBytes(sourceBytes),
        nextHash: hashBytes(nextBytes),
        diff,
        unifiedPatch,
        addedLineCount,
        removedLineCount,
    }
}
