import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveXdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XDG_DATA_HOME?.trim()
  return configured ? configured : join(homedir(), '.local', 'share')
}

export function resolveCodeIntelligenceDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveXdgDataHome(env), 'pi-code-intelligence')
}

export function resolveRepoStorageDir(repoKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCodeIntelligenceDataDir(env), 'repos', repoKey)
}

export function resolveModelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCodeIntelligenceDataDir(env), 'models')
}
