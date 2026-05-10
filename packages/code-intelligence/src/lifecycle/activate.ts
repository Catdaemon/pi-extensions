import { mkdir } from 'node:fs/promises'
import type { CodeIntelligenceConfig } from '../config.ts'
import { loadConfig } from '../config.ts'
import type { CodeIntelligenceDb } from '../db/connection.ts'
import { ensureSingletonStateRows, openCodeIntelligenceDb, upsertRepoMetadata } from '../db/connection.ts'
import { TransformersEmbeddingService } from '../embeddings/transformersEmbeddingService.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import { CodeIntelligenceFileWatcher } from '../indexing/fileWatcher.ts'
import { IndexScheduler } from '../indexing/indexScheduler.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'
import { identifyRepo } from '../repo/identifyRepo.ts'
import { resolveRepoStorageDir } from '../repo/storage.ts'
import { ensureCodeIntelligenceInstall } from './install.ts'
import { ServiceRegistry } from './serviceRegistry.ts'

export type CodeIntelligenceRuntime = {
  identity: RepoIdentity
  storageDir: string
  db: CodeIntelligenceDb
  config: CodeIntelligenceConfig
  activatedAt: string
  services: ServiceRegistry
  indexScheduler: IndexScheduler
  fileWatcher: CodeIntelligenceFileWatcher
}

export async function activateCodeIntelligence(
  cwd: string,
  logger: CodeIntelligenceLogger,
  providedIdentity?: RepoIdentity
): Promise<CodeIntelligenceRuntime> {
  await ensureCodeIntelligenceInstall(logger)
  const identity = providedIdentity ?? (await identifyRepo(cwd))
  const storageDir = resolveRepoStorageDir(identity.repoKey)
  const config = await loadConfig(identity.gitRoot)

  await mkdir(storageDir, { recursive: true })

  const db = await openCodeIntelligenceDb(storageDir)
  upsertRepoMetadata(db, identity)
  ensureSingletonStateRows(db, identity)

  const activatedAt = new Date().toISOString()
  const embeddingService = new TransformersEmbeddingService(config, logger)

  const indexScheduler = new IndexScheduler({ identity, db, config, logger, embeddingService, dbStorageDir: storageDir })
  const fileWatcher = new CodeIntelligenceFileWatcher({
    repoRoot: identity.gitRoot,
    config,
    indexScheduler,
    logger,
  })
  fileWatcher.start()

  const services = new ServiceRegistry()
  services.set('logger', logger)
  services.set('identity', identity)
  services.set('storageDir', storageDir)
  services.set('config', config)
  services.set('db', db)
  services.set('embeddingService', embeddingService)
  services.set('indexScheduler', indexScheduler)
  services.set('fileWatcher', fileWatcher)

  logger.info('activated', {
    repoKey: identity.repoKey,
    gitRoot: identity.gitRoot,
    identitySource: identity.identitySource,
    storageDir,
  })

  return { identity, storageDir, db, config, activatedAt, services, indexScheduler, fileWatcher }
}

