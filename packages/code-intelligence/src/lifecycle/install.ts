import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { closeCodeIntelligenceDb, openCodeIntelligenceGlobalDb } from '../db/connection.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import { resolveCodeIntelligenceDataDir, resolveModelCacheDir } from '../repo/storage.ts'

export type InstallCheck = {
  name: string
  ok: boolean
  message: string
}

export type CodeIntelligenceInstallStatus = {
  dataDir: string
  modelCacheDir: string
  globalDbPath: string
  checks: InstallCheck[]
}

export async function ensureCodeIntelligenceInstall(
  logger?: CodeIntelligenceLogger,
  env: NodeJS.ProcessEnv = process.env
): Promise<CodeIntelligenceInstallStatus> {
  const dataDir = resolveCodeIntelligenceDataDir(env)
  const modelCacheDir = resolveModelCacheDir(env)
  const globalDbPath = join(dataDir, 'global.sqlite')
  const checks: InstallCheck[] = []

  try {
    await mkdir(dataDir, { recursive: true })
    checks.push({ name: 'data_dir', ok: true, message: dataDir })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ name: 'data_dir', ok: false, message })
    throw error
  }

  try {
    await mkdir(modelCacheDir, { recursive: true })
    checks.push({ name: 'model_cache_dir', ok: true, message: modelCacheDir })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    checks.push({ name: 'model_cache_dir', ok: false, message })
    throw error
  }

  const db = await openCodeIntelligenceGlobalDb(env)
  try {
    checks.push({ name: 'global_db', ok: true, message: globalDbPath })
  } finally {
    closeCodeIntelligenceDb(db)
  }

  for (const dependency of ['better-sqlite3', '@huggingface/transformers']) {
    try {
      await import(dependency)
      checks.push({ name: `dependency:${dependency}`, ok: true, message: 'available' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      checks.push({ name: `dependency:${dependency}`, ok: false, message })
      logger?.warn('code intelligence dependency unavailable', { dependency, error: message })
    }
  }

  logger?.info('code intelligence install path ready', { dataDir, modelCacheDir, globalDbPath })
  return { dataDir, modelCacheDir, globalDbPath, checks }
}

export function formatInstallStatus(status: CodeIntelligenceInstallStatus): string {
  return [
    'Code intelligence install status:',
    `dataDir: ${status.dataDir}`,
    `modelCacheDir: ${status.modelCacheDir}`,
    `globalDb: ${status.globalDbPath}`,
    'checks:',
    ...status.checks.map((check) => `- ${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.message}`),
  ].join('\n')
}
