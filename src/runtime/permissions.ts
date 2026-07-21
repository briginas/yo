import { extname } from 'node:path'

const SENSITIVE_DIRECTORY_NAMES = new Set(['.git', '.ssh', '.aws', '.gnupg'])

const SENSITIVE_FILE_NAMES = new Set([
    '.npmrc',
    '.pypirc',
    '.netrc',
    'credentials.json',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
])

const SENSITIVE_FILE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx'])

export type PermissionDeniedReason =
    'outside_workspace' | 'sensitive_path' | 'read_only_policy' | 'unknown_tool'

export type PermissionDecision =
    | {
          decision: 'allow'
      }
    | {
          decision: 'deny'
          reason: PermissionDeniedReason
      }

export type WorkspacePathPermissionDecision =
    | {
          decision: 'allow'
          absolutePath: string
          relativePath: string
      }
    | {
          decision: 'deny'
          reason: Extract<PermissionDeniedReason, 'outside_workspace' | 'sensitive_path'>
      }

export const isSensitivePath = (relativePath: string): boolean => {
    const pathSegments = relativePath
        .split(/[\\/]+/)
        .filter((segment) => segment.length > 0 && segment !== '.')
        .map((segment) => segment.toLowerCase())

    return pathSegments.some(
        (segment) =>
            segment.startsWith('.env') ||
            SENSITIVE_DIRECTORY_NAMES.has(segment) ||
            SENSITIVE_FILE_NAMES.has(segment) ||
            SENSITIVE_FILE_EXTENSIONS.has(extname(segment))
    )
}
