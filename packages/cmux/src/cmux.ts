import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type PiExecResult = {
  stdout?: string
  stderr?: string
  code?: number
  killed?: boolean
}

export type CmuxNotifyOptions = {
  title: string
  subtitle?: string
  body?: string
  workspace?: string
  surface?: string
  signal?: AbortSignal
}

const CMUX_TIMEOUT_MS = 3000

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeExecResult(value: unknown): PiExecResult {
  if (!value || typeof value !== 'object') return {}
  return {
    stdout: readString('stdout' in value ? value.stdout : undefined),
    stderr: readString('stderr' in value ? value.stderr : undefined),
    code: readNumber('code' in value ? value.code : undefined),
    killed: readBoolean('killed' in value ? value.killed : undefined),
  }
}

export function isCmuxEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.CMUX_WORKSPACE_ID && env.CMUX_SURFACE_ID)
}

export async function runCmux(
  pi: ExtensionAPI,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number; requireCmuxEnv?: boolean } = {}
) {
  if (options.requireCmuxEnv !== false && !isCmuxEnvironment()) {
    return { ok: false, skipped: true, reason: 'not in cmux', stdout: '', stderr: '' }
  }

  try {
    const result = normalizeExecResult(await pi.exec('cmux', args, {
      signal: options.signal,
      timeout: options.timeout ?? CMUX_TIMEOUT_MS,
    }))

    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const code = result.code ?? 0

    return {
      ok: code === 0 && !result.killed,
      skipped: false,
      code,
      killed: Boolean(result.killed),
      stdout,
      stderr,
      reason: code === 0 && !result.killed ? undefined : stderr || stdout || `cmux exited with code ${code}`,
    }
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      code: undefined,
      killed: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export function getCmuxWorkspace(env: NodeJS.ProcessEnv = process.env) {
  return env.CMUX_WORKSPACE_ID
}

export function getCmuxSurface(env: NodeJS.ProcessEnv = process.env) {
  return env.CMUX_SURFACE_ID
}

export async function notifyCmux(pi: ExtensionAPI, options: CmuxNotifyOptions) {
  const args = ['notify', '--title', options.title]

  if (options.subtitle) args.push('--subtitle', options.subtitle)
  if (options.body) args.push('--body', options.body)
  if (options.workspace) args.push('--workspace', options.workspace)
  if (options.surface) args.push('--surface', options.surface)

  return runCmux(pi, args, { signal: options.signal })
}

export async function notifyCmuxNeedsFeedback(
  pi: ExtensionAPI,
  body: string,
  options: { title?: string; subtitle?: string; signal?: AbortSignal } = {}
) {
  return notifyCmux(pi, {
    title: options.title ?? 'Pi needs feedback',
    subtitle: options.subtitle ?? 'Action required',
    body,
    signal: options.signal,
  })
}

export async function notifyCmuxDone(
  pi: ExtensionAPI,
  body: string,
  options: { title?: string; subtitle?: string; signal?: AbortSignal } = {}
) {
  return notifyCmux(pi, {
    title: options.title ?? 'Pi',
    subtitle: options.subtitle ?? 'Done',
    body,
    signal: options.signal,
  })
}

export async function setCmuxStatus(
  pi: ExtensionAPI,
  key: string,
  value: string,
  options: { icon?: string; color?: string; signal?: AbortSignal } = {}
) {
  const args = ['set-status', key, value]
  if (options.icon) args.push('--icon', options.icon)
  if (options.color) args.push('--color', options.color)
  return runCmux(pi, args, { signal: options.signal })
}

export async function clearCmuxStatus(pi: ExtensionAPI, key: string, options: { signal?: AbortSignal } = {}) {
  return runCmux(pi, ['clear-status', key], { signal: options.signal })
}
