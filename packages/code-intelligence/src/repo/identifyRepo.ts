import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { normalizeRemoteUrl } from './normalizeRemoteUrl.ts'

const execFileAsync = promisify(execFile)

export type RepoIdentity = {
  repoKey: string
  originUrl?: string
  normalizedOriginUrl?: string
  gitRoot: string
  defaultBranch?: string
  identitySource: 'origin' | 'path'
}

export async function identifyRepo(cwd: string): Promise<RepoIdentity> {
  const gitRoot = await findGitRoot(cwd)
  const originUrl = await getGitOutput(gitRoot, ['remote', 'get-url', 'origin'])
  const normalizedOriginUrl = originUrl ? normalizeRemoteUrl(originUrl) : undefined
  const identityMaterial = normalizedOriginUrl || (await realpath(gitRoot))
  const defaultBranch = await resolveDefaultBranch(gitRoot)

  return {
    repoKey: computeRepoKey(identityMaterial),
    originUrl,
    normalizedOriginUrl,
    gitRoot: await realpath(gitRoot),
    defaultBranch,
    identitySource: normalizedOriginUrl ? 'origin' : 'path',
  }
}

export function computeRepoKey(identityMaterial: string): string {
  return createHash('sha256').update(identityMaterial).digest('hex')
}

export async function findGitRoot(cwd: string): Promise<string> {
  const root = await getGitOutput(cwd, ['rev-parse', '--show-toplevel'])
  return root || realpath(cwd)
}

async function resolveDefaultBranch(gitRoot: string): Promise<string | undefined> {
  const originHead = await getGitOutput(gitRoot, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (originHead?.startsWith('origin/')) return originHead.slice('origin/'.length)
  if (originHead) return originHead

  const current = await getGitOutput(gitRoot, ['branch', '--show-current'])
  return current || undefined
}

async function getGitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    })
    const text = String(stdout).trim()
    return text || undefined
  } catch {
    return undefined
  }
}
