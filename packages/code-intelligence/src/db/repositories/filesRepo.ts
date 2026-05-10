import { and, eq, isNull, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { chunks, files } from '../schema.ts'

export type IndexedFileRow = {
  id: number
  repo_key: string
  package_key: string | null
  path: string
  language: string | null
  file_hash: string
  size_bytes: number | null
  is_generated: number
  generated_reason: string | null
  last_indexed_at: string
  deleted_at: string | null
}

export type UpsertIndexedFileInput = {
  repoKey: string
  packageKey?: string
  path: string
  language?: string
  fileHash: string
  sizeBytes: number
  isGenerated: boolean
  generatedReason?: string
  indexedAt?: string
}

export type UpsertIndexedFileResult = {
  id: number
  changed: boolean
  skippedUnchanged: boolean
}

export function getIndexedFileByPath(db: CodeIntelligenceDb, repoKey: string, path: string): IndexedFileRow | undefined {
  const row = db.select().from(files).where(and(eq(files.repoKey, repoKey), eq(files.path, path))).get()
  return row ? fileToRow(row) : undefined
}

export function upsertIndexedFile(db: CodeIntelligenceDb, input: UpsertIndexedFileInput): UpsertIndexedFileResult {
  const existing = getIndexedFileByPath(db, input.repoKey, input.path)
  const indexedAt = input.indexedAt ?? new Date().toISOString()
  const values = {
    repoKey: input.repoKey,
    packageKey: input.packageKey ?? null,
    path: input.path,
    language: input.language ?? null,
    fileHash: input.fileHash,
    sizeBytes: input.sizeBytes,
    isGenerated: input.isGenerated ? 1 : 0,
    generatedReason: input.generatedReason ?? null,
    lastIndexedAt: indexedAt,
    deletedAt: null,
  }

  if (
    existing &&
    existing.file_hash === input.fileHash &&
    existing.deleted_at === null &&
    existing.is_generated === values.isGenerated &&
    existing.generated_reason === values.generatedReason
  ) {
    db.update(files).set({ lastIndexedAt: indexedAt }).where(eq(files.id, existing.id)).run()
    return { id: existing.id, changed: false, skippedUnchanged: true }
  }

  db
    .insert(files)
    .values(values)
    .onConflictDoUpdate({
      target: [files.repoKey, files.path],
      set: {
        packageKey: values.packageKey,
        language: values.language,
        fileHash: values.fileHash,
        sizeBytes: values.sizeBytes,
        isGenerated: values.isGenerated,
        generatedReason: values.generatedReason,
        lastIndexedAt: values.lastIndexedAt,
        deletedAt: null,
      },
    })
    .run()

  const row = getIndexedFileByPath(db, input.repoKey, input.path)
  if (!row) throw new Error(`Failed to upsert indexed file: ${input.path}`)
  return { id: row.id, changed: true, skippedUnchanged: false }
}

export function findMissingActiveFilePaths(db: CodeIntelligenceDb, repoKey: string, seenPaths: Set<string>): string[] {
  return db
    .select({ path: files.path })
    .from(files)
    .where(and(eq(files.repoKey, repoKey), isNull(files.deletedAt)))
    .all()
    .map((row) => row.path)
    .filter((path) => !seenPaths.has(path))
}

export function markFileDeleted(db: CodeIntelligenceDb, repoKey: string, path: string, deletedAt = new Date().toISOString()): boolean {
  return db
    .update(files)
    .set({ deletedAt })
    .where(and(eq(files.repoKey, repoKey), eq(files.path, path), isNull(files.deletedAt)))
    .run().changes > 0
}

export function findActiveFilePaths(db: CodeIntelligenceDb, repoKey: string): string[] {
  return db
    .select({ path: files.path })
    .from(files)
    .where(and(eq(files.repoKey, repoKey), isNull(files.deletedAt)))
    .all()
    .map((row) => row.path)
}

export function markMissingFilesDeleted(db: CodeIntelligenceDb, repoKey: string, seenPaths: Set<string>, deletedAt = new Date().toISOString()): number {
  const missing = findMissingActiveFilePaths(db, repoKey, seenPaths)
  db.transaction((tx) => {
    for (const path of missing) tx.update(files).set({ deletedAt }).where(and(eq(files.repoKey, repoKey), eq(files.path, path))).run()
  })
  return missing.length
}

export function pruneDeletedFileRows(db: CodeIntelligenceDb, repoKey: string, olderThan: string): number {
  return db.delete(files)
    .where(and(
      eq(files.repoKey, repoKey),
      sql`${files.deletedAt} IS NOT NULL`,
      sql`${files.deletedAt} < ${olderThan}`,
      sql`NOT EXISTS (SELECT 1 FROM ${chunks} WHERE ${chunks.fileId} = ${files.id})`
    ))
    .run().changes
}

export function getFileIndexStats(db: CodeIntelligenceDb, repoKey: string): {
  totalFiles: number
  activeFiles: number | null
  generatedFiles: number | null
  lastIndexedAt: string | null
} {
  return db.get(sql`SELECT
        COUNT(*) AS totalFiles,
        SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS activeFiles,
        SUM(CASE WHEN deleted_at IS NULL AND is_generated = 1 THEN 1 ELSE 0 END) AS generatedFiles,
        MAX(last_indexed_at) AS lastIndexedAt
      FROM files
      WHERE repo_key = ${repoKey}`) as {
    totalFiles: number
    activeFiles: number | null
    generatedFiles: number | null
    lastIndexedAt: string | null
  }
}

function fileToRow(row: typeof files.$inferSelect): IndexedFileRow {
  return {
    id: row.id,
    repo_key: row.repoKey,
    package_key: row.packageKey,
    path: row.path,
    language: row.language,
    file_hash: row.fileHash,
    size_bytes: row.sizeBytes,
    is_generated: row.isGenerated,
    generated_reason: row.generatedReason,
    last_indexed_at: row.lastIndexedAt,
    deleted_at: row.deletedAt,
  }
}
