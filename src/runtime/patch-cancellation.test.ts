import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import {
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    unlink,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import {
    applyPatchProposalWithTimeout,
    PatchApplicationError,
    type PatchApplicationOperations,
} from './patch-applier.ts'
import { preparePatchProposal, readBoundedFile, resolvePatchTarget } from './patch-preparer.ts'
import type { PatchApprovalDecision } from './patch-contracts.ts'
import { dispatchToolCall, type PatchDispatchOptions } from './tool-dispatcher.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

const directories = new Set<string>()
const before = '\uFEFFconst value = "before"\r\n'
const after = '\uFEFFconst value = "after"\r\n'
const call = {
    id: 'cancelled-patch',
    name: 'propose_patch',
    arguments: { path: 'src/example.ts', edits: [{ oldText: 'before', newText: 'after' }] },
}
const drain = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve))
}
const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'yo-patch-cancellation-'))
    directories.add(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/example.ts'), before)
    const workspaceRoot = await canonicalizeWorkspaceRoot(root)
    return { workspaceRoot, sourcePath: join(workspaceRoot, 'src/example.ts') }
}
const nativeOperations = (): PatchApplicationOperations => ({
    resolveTarget: (root, path, signal) => resolvePatchTarget(root, path, undefined, signal),
    readFile: readBoundedFile,
    openTemporaryFile: (path, mode) =>
        open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode),
    rename,
    unlink,
    randomUUID: () => 'controlled',
})
const eventRecorder = () => {
    const events: Array<Parameters<NonNullable<PatchDispatchOptions['onLifecycleEvent']>>[0]> = []
    return {
        events,
        onLifecycleEvent: (event: (typeof events)[number]) => {
            events.push(event)
        },
    }
}
afterEach(async () => {
    const roots = [...directories]
    directories.clear()
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

test('pending review receives run signal and late affirmative settlement cannot apply', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { workspaceRoot, sourcePath } = await fixture()
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const review = Promise.withResolvers<PatchApprovalDecision>()
    const trail = eventRecorder()
    let applications = 0
    let settled = false
    const pending = dispatchToolCall(
        workspaceRoot,
        call,
        10,
        undefined,
        {
            ...trail,
            approver: async (_view, options) => {
                assert.equal(options?.signal, controller.signal)
                started.resolve()
                return review.promise
            },
            operations: {
                applyProposal: async () => {
                    applications += 1
                    return { status: 'applied' }
                },
            },
        },
        { signal: controller.signal }
    ).then((result) => {
        settled = true
        return result
    })
    await started.promise
    t.mock.timers.tick(100)
    assert.equal(settled, false)
    controller.abort('private reason')
    assert.equal(settled, false)
    review.resolve('approved')
    const result = await pending
    assert.equal(result.status, 'aborted')
    assert.equal(result.callId, call.id)
    assert.equal(result.error?.code, 'approval_aborted')
    assert.equal(applications, 0)
    assert.deepEqual(
        trail.events.map((event) => event.type),
        ['prepared', 'approval_requested', 'approval_resolved']
    )
    assert.equal(
        trail.events[2]?.type === 'approval_resolved' && trail.events[2].decision,
        'aborted'
    )
    assert.equal(await readFile(sourcePath, 'utf8'), before)
})

test('cancellation after accepted consent skips application without relabelling consent', async () => {
    const { workspaceRoot, sourcePath } = await fixture()
    const controller = new AbortController()
    const trail = eventRecorder()
    let applications = 0
    const result = await dispatchToolCall(
        workspaceRoot,
        call,
        1000,
        undefined,
        {
            approver: async () => 'approved',
            onLifecycleEvent: (event) => {
                trail.onLifecycleEvent(event)
                if (event.type === 'approval_resolved') controller.abort()
            },
            operations: {
                applyProposal: async () => {
                    applications += 1
                    return { status: 'applied' }
                },
            },
        },
        { signal: controller.signal }
    )
    assert.equal(result.status, 'aborted')
    assert.equal(result.error?.code, 'aborted')
    assert.equal(applications, 0)
    assert.equal(
        trail.events[2]?.type === 'approval_resolved' && trail.events[2].decision,
        'approved'
    )
    assert.equal(await readFile(sourcePath, 'utf8'), before)
})

for (const decision of ['denied', 'aborted'] as const) {
    test(`${decision} approval settles only its call and a fresh proposal needs fresh consent`, async () => {
        const { workspaceRoot, sourcePath } = await fixture()
        const controller = new AbortController()
        const trail = eventRecorder()
        const stopped = await dispatchToolCall(
            workspaceRoot,
            call,
            1000,
            undefined,
            {
                ...trail,
                approver: async () => decision,
            },
            { signal: controller.signal }
        )
        assert.equal(stopped.status, decision)
        assert.equal(controller.signal.aborted, false)
        assert.equal(await readFile(sourcePath, 'utf8'), before)
        let approvals = 0
        const result = await dispatchToolCall(
            workspaceRoot,
            { ...call, id: 'fresh-patch' },
            1000,
            undefined,
            {
                approver: async () => {
                    approvals += 1
                    return 'approved'
                },
            },
            { signal: controller.signal }
        )
        assert.equal(result.status, 'success')
        assert.equal(approvals, 1)
        assert.equal(await readFile(sourcePath, 'utf8'), after)
        assert.deepEqual(
            trail.events.map((event) => event.type),
            ['prepared', 'approval_requested', 'approval_resolved']
        )
    })
}

for (const first of ['timeout', 'aborted'] as const) {
    test(`${first} wins through held native temporary write, close and cleanup without rename`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { workspaceRoot, sourcePath } = await fixture()
        const proposal = await preparePatchProposal(
            workspaceRoot,
            call.arguments.path,
            call.arguments.edits
        )
        const controller = new AbortController()
        const writing = Promise.withResolvers<void>()
        const releaseWrite = Promise.withResolvers<void>()
        const closing = Promise.withResolvers<void>()
        const releaseClose = Promise.withResolvers<void>()
        const cleaning = Promise.withResolvers<void>()
        const releaseCleanup = Promise.withResolvers<void>()
        const operations = nativeOperations()
        let renames = 0
        let settled = false
        const pending = applyPatchProposalWithTimeout(workspaceRoot, proposal, 10, {
            signal: controller.signal,
            operations: {
                ...operations,
                openTemporaryFile: async (path, mode) => {
                    const file = await operations.openTemporaryFile(path, mode)
                    return {
                        ...file,
                        chmod: (mode) => file.chmod(mode),
                        sync: () => file.sync(),
                        writeFile: async (content) => {
                            writing.resolve()
                            await releaseWrite.promise
                            await file.writeFile(content)
                        },
                        close: async () => {
                            closing.resolve()
                            await releaseClose.promise
                            await file.close()
                        },
                    }
                },
                rename: async (from, to) => {
                    renames += 1
                    await operations.rename(from, to)
                },
                unlink: async (path) => {
                    cleaning.resolve()
                    await releaseCleanup.promise
                    await operations.unlink(path)
                },
            },
        }).then((result) => {
            settled = true
            return result
        })
        await writing.promise
        if (first === 'timeout') {
            t.mock.timers.tick(10)
            controller.abort()
        } else {
            controller.abort()
            t.mock.timers.tick(10)
        }
        assert.equal(settled, false)
        releaseWrite.resolve()
        await closing.promise
        assert.equal(settled, false)
        releaseClose.resolve()
        await cleaning.promise
        assert.equal(settled, false)
        assert.equal(renames, 0)
        assert.equal(await readFile(sourcePath, 'utf8'), before)
        releaseCleanup.resolve()
        assert.deepEqual(await pending, { status: first })
        assert.deepEqual(await readdir(join(workspaceRoot, 'src')), ['example.ts'])
    })
}

for (const renameOutcome of ['success', 'failure', 'typed-abort-failure'] as const) {
    test(`initiated native rename ${renameOutcome} after cancellation agrees with bytes and sole lifecycle trail`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { workspaceRoot, sourcePath } = await fixture()
        const controller = new AbortController()
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const cleanupStarted = Promise.withResolvers<void>()
        const cleanupRelease = Promise.withResolvers<void>()
        const operations = nativeOperations()
        const trail = eventRecorder()
        let settled = false
        let renames = 0
        const pending = dispatchToolCall(
            workspaceRoot,
            call,
            10,
            undefined,
            {
                ...trail,
                approver: async () => 'approved',
                operations: {
                    applyProposal: async (root, proposal, timeoutMs, options) => {
                        assert.equal(options?.signal, controller.signal)
                        return applyPatchProposalWithTimeout(root, proposal, timeoutMs, {
                            ...options,
                            operations: {
                                ...operations,
                                rename: async (from, to) => {
                                    renames += 1
                                    started.resolve()
                                    await release.promise
                                    if (renameOutcome === 'failure')
                                        throw new Error('private rename failure')
                                    if (renameOutcome === 'typed-abort-failure')
                                        throw new PatchApplicationError(
                                            'aborted',
                                            'private rename abort'
                                        )
                                    await operations.rename(from, to)
                                },
                                unlink: async (path) => {
                                    cleanupStarted.resolve()
                                    await cleanupRelease.promise
                                    await operations.unlink(path)
                                },
                            },
                        })
                    },
                },
            },
            { signal: controller.signal }
        ).then((result) => {
            settled = true
            return result
        })
        await started.promise
        controller.abort('private abort')
        t.mock.timers.tick(100)
        assert.equal(settled, false)
        release.resolve()
        if (renameOutcome !== 'success') {
            await cleanupStarted.promise
            assert.equal(settled, false)
            cleanupRelease.resolve()
        }
        const result = await pending
        assert.equal(renames, 1)
        assert.equal(result.callId, call.id)
        assert.equal(result.status, renameOutcome === 'success' ? 'success' : 'execution_error')
        assert.equal(result.content.includes('private'), false)
        assert.deepEqual(
            trail.events.map((event) => event.type),
            [
                'prepared',
                'approval_requested',
                'approval_resolved',
                ...(renameOutcome === 'success' ? ['applied'] : []),
            ]
        )
        assert.equal(
            await readFile(sourcePath, 'utf8'),
            renameOutcome === 'success' ? after : before
        )
        assert.deepEqual(await readdir(join(workspaceRoot, 'src')), ['example.ts'])
    })
}

test('application signal reaches nested path revalidation and prevents later components', async () => {
    const { workspaceRoot, sourcePath } = await fixture()
    const proposal = await preparePatchProposal(
        workspaceRoot,
        call.arguments.path,
        call.arguments.edits
    )
    const controller = new AbortController()
    const calls: string[] = []
    const operations = nativeOperations()
    const outcome = await applyPatchProposalWithTimeout(workspaceRoot, proposal, 1000, {
        signal: controller.signal,
        operations: {
            ...operations,
            resolveTarget: async (root, path, signal) =>
                resolvePatchTarget(
                    root,
                    path,
                    {
                        lstat: async (component) => {
                            calls.push('lstat')
                            const result = await lstat(component)
                            controller.abort()
                            return result
                        },
                        realpath: async (path) => {
                            calls.push('realpath')
                            return realpath(path)
                        },
                        readFile: readBoundedFile,
                        randomUUID: () => 'unused',
                    },
                    signal
                ),
            readFile: async (path, maxBytes, signal) => {
                calls.push('read')
                return readBoundedFile(path, maxBytes, signal)
            },
            openTemporaryFile: async (path, mode) => {
                calls.push('temporary')
                return operations.openTemporaryFile(path, mode)
            },
        },
    })
    assert.deepEqual(outcome, { status: 'aborted' })
    assert.deepEqual(calls, ['lstat'])
    assert.equal(await readFile(sourcePath, 'utf8'), before)
})

test('cancellation during acquired source read waits for handle close and skips temporary I/O', async () => {
    const { workspaceRoot, sourcePath } = await fixture()
    const proposal = await preparePatchProposal(
        workspaceRoot,
        call.arguments.path,
        call.arguments.edits
    )
    const controller = new AbortController()
    const reading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const closing = Promise.withResolvers<void>()
    const releaseClose = Promise.withResolvers<void>()
    const operations = nativeOperations()
    let settled = false
    let temporaryFiles = 0
    const pending = applyPatchProposalWithTimeout(workspaceRoot, proposal, 1000, {
        signal: controller.signal,
        operations: {
            ...operations,
            readFile: (path, maxBytes, signal) =>
                readBoundedFile(path, maxBytes, signal, async (path, flags) => {
                    const file = await open(path, flags)
                    return {
                        read: async (buffer, offset, length, position) => {
                            reading.resolve()
                            await release.promise
                            return file.read(buffer, offset, length, position)
                        },
                        close: async () => {
                            closing.resolve()
                            await releaseClose.promise
                            await file.close()
                        },
                    }
                }),
            openTemporaryFile: async (path, mode) => {
                temporaryFiles += 1
                return operations.openTemporaryFile(path, mode)
            },
        },
    }).then((result) => {
        settled = true
        return result
    })
    await reading.promise
    controller.abort()
    release.resolve()
    await closing.promise
    assert.equal(settled, false)
    releaseClose.resolve()
    assert.deepEqual(await pending, { status: 'aborted' })
    assert.equal(temporaryFiles, 0)
    assert.equal(await readFile(sourcePath, 'utf8'), before)
})

test('a failure committed before cancellation during held cleanup stays a sanitized failure', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { workspaceRoot } = await fixture()
    const proposal = await preparePatchProposal(
        workspaceRoot,
        call.arguments.path,
        call.arguments.edits
    )
    const controller = new AbortController()
    const cleaning = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const operations = nativeOperations()
    const pending = applyPatchProposalWithTimeout(workspaceRoot, proposal, 10, {
        signal: controller.signal,
        operations: {
            ...operations,
            openTemporaryFile: async () => {
                throw new Error('private open failure')
            },
            unlink: async () => {
                cleaning.resolve()
                await release.promise
            },
        },
    })
    const rejected = assert.rejects(
        pending,
        (error: unknown) =>
            error instanceof PatchApplicationError &&
            error.code === 'filesystem_error' &&
            error.message === 'Unable to apply approved patch'
    )
    await cleaning.promise
    controller.abort()
    t.mock.timers.tick(100)
    release.resolve()
    await rejected
})

test('pre-aborted application skips every I/O operation and disposes its listener and timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { workspaceRoot } = await fixture()
    const proposal = await preparePatchProposal(
        workspaceRoot,
        call.arguments.path,
        call.arguments.edits
    )
    const controller = new AbortController()
    controller.abort('private reason')
    const remove = t.mock.method(controller.signal, 'removeEventListener')
    const operations = nativeOperations()
    let io = 0
    assert.deepEqual(
        await applyPatchProposalWithTimeout(workspaceRoot, proposal, 10, {
            signal: controller.signal,
            operations: {
                ...operations,
                resolveTarget: async () => {
                    io += 1
                    throw new Error('unexpected')
                },
            },
        }),
        { status: 'aborted' }
    )
    t.mock.timers.tick(100)
    assert.equal(io, 0)
    assert.equal(remove.mock.callCount(), 1)
    await drain()
})

for (const result of ['applied', 'conflict', 'failure'] as const) {
    test(`committed ${result} application disposes listener and ignores later cancellation`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] })
        const { workspaceRoot, sourcePath } = await fixture()
        const proposal = await preparePatchProposal(
            workspaceRoot,
            call.arguments.path,
            call.arguments.edits
        )
        const controller = new AbortController()
        const remove = t.mock.method(controller.signal, 'removeEventListener')
        const operations = nativeOperations()
        let combined: AbortSignal | undefined
        if (result === 'conflict') await writeFile(sourcePath, 'newer\n')
        const pending = applyPatchProposalWithTimeout(workspaceRoot, proposal, 10, {
            signal: controller.signal,
            operations: {
                ...operations,
                resolveTarget: async (root, path, signal) => {
                    combined = signal
                    if (result === 'failure') throw new Error('private failure')
                    return operations.resolveTarget(root, path, signal)
                },
            },
        })
        if (result === 'failure') await assert.rejects(pending, PatchApplicationError)
        else assert.equal((await pending).status, result)
        assert.equal(remove.mock.callCount(), 1)
        controller.abort()
        t.mock.timers.tick(100)
        assert.equal(combined?.aborted, false)
        assert.equal(
            await readFile(sourcePath, 'utf8'),
            result === 'applied' ? after : result === 'conflict' ? 'newer\n' : before
        )
    })
}

test('cancellation in prepared lifecycle skips actual review and records one aborted decision', async () => {
    const { workspaceRoot, sourcePath } = await fixture()
    const controller = new AbortController()
    const trail = eventRecorder()
    let reviews = 0
    const result = await dispatchToolCall(
        workspaceRoot,
        call,
        1000,
        undefined,
        {
            approver: async () => {
                reviews += 1
                return 'approved'
            },
            onLifecycleEvent: (event) => {
                trail.onLifecycleEvent(event)
                if (event.type === 'prepared') controller.abort()
            },
        },
        { signal: controller.signal }
    )
    assert.equal(result.status, 'aborted')
    assert.equal(reviews, 0)
    assert.deepEqual(
        trail.events.map((event) => event.type),
        ['prepared', 'approval_requested', 'approval_resolved']
    )
    assert.equal(
        trail.events[2]?.type === 'approval_resolved' && trail.events[2].decision,
        'aborted'
    )
    assert.equal(await readFile(sourcePath, 'utf8'), before)
})
