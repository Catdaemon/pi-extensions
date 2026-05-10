import { eq } from 'drizzle-orm'
import { openCodeIntelligenceGlobalDb, closeCodeIntelligenceDb } from '../db/connection.ts'
import { enabledRepos } from '../db/schema.ts'
import type { RepoIdentity } from './identifyRepo.ts'
import { resolveCodeIntelligenceDataDir } from './storage.ts'

export type EnabledRepoRecord = {
  repoKey: string
  originUrl?: string
  normalizedOriginUrl?: string
  gitRoot: string
  defaultBranch?: string
  enabledAt: string
  lastSeenAt: string
}

export function resolveEnabledReposDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveCodeIntelligenceDataDir(env)}/global.sqlite`
}

export async function isCodeIntelligenceEnabled(repoKey: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const db = await openCodeIntelligenceGlobalDb(env)
  try {
    return Boolean(db.select({ repoKey: enabledRepos.repoKey }).from(enabledRepos).where(eq(enabledRepos.repoKey, repoKey)).get())
  } finally {
    closeCodeIntelligenceDb(db)
  }
}

export async function getEnabledRepoRecord(repoKey: string, env: NodeJS.ProcessEnv = process.env): Promise<EnabledRepoRecord | undefined> {
  const db = await openCodeIntelligenceGlobalDb(env)
  try {
    const row = db.select().from(enabledRepos).where(eq(enabledRepos.repoKey, repoKey)).get()
    return row ? rowToRecord(row) : undefined
  } finally {
    closeCodeIntelligenceDb(db)
  }
}

export async function listEnabledRepoRecords(env: NodeJS.ProcessEnv = process.env): Promise<EnabledRepoRecord[]> {
  const db = await openCodeIntelligenceGlobalDb(env)
  try {
    return db.select().from(enabledRepos).all().map(rowToRecord)
  } finally {
    closeCodeIntelligenceDb(db)
  }
}

export async function enableCodeIntelligenceRepo(
  identity: RepoIdentity,
  env: NodeJS.ProcessEnv = process.env
): Promise<EnabledRepoRecord> {
  const db = await openCodeIntelligenceGlobalDb(env)
  try {
    const now = new Date().toISOString()
    const existing = db.select().from(enabledRepos).where(eq(enabledRepos.repoKey, identity.repoKey)).get()
    const record = {
      repoKey: identity.repoKey,
      originUrl: identity.originUrl ?? null,
      normalizedOriginUrl: identity.normalizedOriginUrl ?? null,
      gitRoot: identity.gitRoot,
      defaultBranch: identity.defaultBranch ?? null,
      enabledAt: existing?.enabledAt ?? now,
      lastSeenAt: now,
    }
    db
      .insert(enabledRepos)
      .values(record)
      .onConflictDoUpdate({
        target: enabledRepos.repoKey,
        set: {
          originUrl: record.originUrl,
          normalizedOriginUrl: record.normalizedOriginUrl,
          gitRoot: record.gitRoot,
          defaultBranch: record.defaultBranch,
          lastSeenAt: record.lastSeenAt,
        },
      })
      .run()
    return rowToRecord(record)
  } finally {
    closeCodeIntelligenceDb(db)
  }
}

export async function disableCodeIntelligenceRepo(repoKey: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const db = await openCodeIntelligenceGlobalDb(env)
  try {
    return db.delete(enabledRepos).where(eq(enabledRepos.repoKey, repoKey)).run().changes > 0
  } finally {
    closeCodeIntelligenceDb(db)
  }
}

function rowToRecord(row: typeof enabledRepos.$inferSelect): EnabledRepoRecord {
  return {
    repoKey: row.repoKey,
    originUrl: row.originUrl ?? undefined,
    normalizedOriginUrl: row.normalizedOriginUrl ?? undefined,
    gitRoot: row.gitRoot,
    defaultBranch: row.defaultBranch ?? undefined,
    enabledAt: row.enabledAt,
    lastSeenAt: row.lastSeenAt,
  }
}
