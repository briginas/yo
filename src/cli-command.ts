export const USAGE = [
    'Usage: yo [--cwd <workspace>] [--model <name>]',
    '       yo login',
    '       yo auth status',
    '       yo logout',
].join('\n')

export type ChatCommand = {
    name: 'chat'
    cwd: string | null
    model: string | null
}

export type LoginCommand = {
    name: 'login'
}

export type AuthStatusCommand = {
    name: 'auth_status'
}

export type LogoutCommand = {
    name: 'logout'
}

export type CliCommand = ChatCommand | LoginCommand | AuthStatusCommand | LogoutCommand

export type ParseResult =
    | {
          status: 'success'
          command: CliCommand
      }
    | {
          status: 'error'
          message: string
      }

const parseChatCommand = (argv: readonly string[]): ParseResult => {
    let cwd: string | undefined
    let model: string | undefined

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!

        if (argument === '--cwd' || argument === '--model') {
            const value = argv[index + 1]

            if (value === undefined || value.startsWith('-') || value.trim().length === 0) {
                return {
                    status: 'error',
                    message: `${argument} requires a non-empty value`,
                }
            }

            if (argument === '--cwd') {
                if (cwd !== undefined) {
                    return {
                        status: 'error',
                        message: '--cwd may be specified only once',
                    }
                }

                cwd = value
            } else {
                if (model !== undefined) {
                    return {
                        status: 'error',
                        message: '--model may be specified only once',
                    }
                }

                model = value
            }

            index += 1
            continue
        }

        if (argument.startsWith('-')) {
            return {
                status: 'error',
                message: `Unknown option: ${argument}`,
            }
        }

        return {
            status: 'error',
            message: 'yo does not accept positional arguments',
        }
    }

    return {
        status: 'success',
        command: {
            name: 'chat',
            cwd: cwd ?? null,
            model: model ?? null,
        },
    }
}

export const parseCliCommand = (argv: readonly string[]): ParseResult => {
    if (argv[0] === 'login') {
        if (argv.length !== 1) {
            return {
                status: 'error',
                message: 'login does not accept arguments',
            }
        }

        return {
            status: 'success',
            command: { name: 'login' },
        }
    }

    if (argv[0] === 'auth') {
        if (argv[1] !== 'status') {
            return {
                status: 'error',
                message: 'Expected the auth status command',
            }
        }

        if (argv.length !== 2) {
            return {
                status: 'error',
                message: 'auth status does not accept arguments',
            }
        }

        return {
            status: 'success',
            command: { name: 'auth_status' },
        }
    }

    if (argv[0] === 'logout') {
        if (argv.length !== 1) {
            return {
                status: 'error',
                message: 'logout does not accept arguments',
            }
        }

        return {
            status: 'success',
            command: { name: 'logout' },
        }
    }

    return parseChatCommand(argv)
}
