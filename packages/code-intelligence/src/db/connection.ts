import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { runDrizzleMigrations } from './migrations.ts'
import { embeddingStatus, indexingState, repoMetadata, schema } from './schema.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'
import { resolveCodeIntelligenceDataDir, resolveModelCacheDir } from '../repo/storage.ts'

export type CodeIntelligenceDb = BetterSQLite3Database<typeof schema> & { close: () => void }

export async function openCodeIntelligenceDb(storageDir: string): Promise<CodeIntelligenceDb> {
  await mkdir(storageDir, { recursive: true })
  const sqlite = new Database(join(storageDir, 'memory.sqlite'), { timeout: 10_000 })
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 10000')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema }) as unknown as CodeIntelligenceDb
  db.close = () => sqlite.close()
  runDrizzleMigrations(db)
  return db
}

export async function openCodeIntelligenceGlobalDb(env: NodeJS.ProcessEnv = process.env): Promise<CodeIntelligenceDb> {
  const dataDir = resolveCodeIntelligenceDataDir(env)
  await mkdir(dataDir, { recursive: true })
  const sqlite = new Database(join(dataDir, 'global.sqlite'), { timeout: 10_000 })
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 10000')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema }) as unknown as CodeIntelligenceDb
  db.close = () => sqlite.close()
  runDrizzleMigrations(db)
  return db
}

export function closeCodeIntelligenceDb(db: CodeIntelligenceDb | undefined): void {
  db?.close()
}

export function upsertRepoMetadata(db: CodeIntelligenceDb, identity: RepoIdentity): void {
  const now = new Date().toISOString()
  db
    .insert(repoMetadata)
    .values({
      repoKey: identity.repoKey,
      originUrl: identity.originUrl ?? null,
      normalizedOriginUrl: identity.normalizedOriginUrl ?? null,
      gitRoot: identity.gitRoot,
      defaultBranch: identity.defaultBranch ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: repoMetadata.repoKey,
      set: {
        originUrl: identity.originUrl ?? null,
        normalizedOriginUrl: identity.normalizedOriginUrl ?? null,
        gitRoot: identity.gitRoot,
        defaultBranch: identity.defaultBranch ?? null,
        updatedAt: now,
      },
    })
    .run()
}

export function ensureSingletonStateRows(db: CodeIntelligenceDb, identity: RepoIdentity): void {
  const now = new Date().toISOString()
  db
    .insert(indexingState)
    .values({ id: 1, repoKey: identity.repoKey, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: indexingState.id,
      set: { repoKey: identity.repoKey, updatedAt: now },
    })
    .run()

  const existing = db.select({ id: embeddingStatus.id }).from(embeddingStatus).where(eq(embeddingStatus.id, 1)).get()
  db
    .insert(embeddingStatus)
    .values({
      id: 1,
      provider: 'transformers',
      status: existing ? 'not_started' : 'not_started',
      cacheDir: resolveModelCacheDir(),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: embeddingStatus.id,
      set: { provider: 'transformers', cacheDir: resolveModelCacheDir(), updatedAt: now },
    })
    .run()
}
