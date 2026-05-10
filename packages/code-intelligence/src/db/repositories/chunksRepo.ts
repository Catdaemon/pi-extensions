import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { CodeIntelligenceDb } from '../connection.ts'
import { chunkEmbeddings, chunks, files } from '../schema.ts'

export type ChunkInput = {
  repoKey: string
  fileId: number
  path: string
  packageKey?: string
  language?: string
  chunkKind: string
  symbolName?: string
  symbolKind?: string
  startLine: number
  endLine: number
  content: string
  contentHash: string
}

export type ChunkRow = {
  id: number
  repo_key: string
  file_id: number
  path: string
  package_key: string | null
  language: string | null
  chunk_kind: string
  symbol_name: string | null
  symbol_kind: string | null
  start_line: number
  end_line: number
  content: string
  content_hash: string
}

export type RetrievedChunkRow = ChunkRow & { rank: number }
export type InsertedChunk = ChunkInput & { insertedChunkId: number }

export function replaceChunksForFile(db: CodeIntelligenceDb, fileId: number, inputChunks: ChunkInput[]): InsertedChunk[] {
  const existing = db.select({ id: chunks.id }).from(chunks).where(eq(chunks.fileId, fileId)).all()
  const now = new Date().toISOString()
  const inserted: InsertedChunk[] = []

  db.transaction((tx) => {
    for (const row of existing) {
      tx.run(sql`DELETE FROM chunk_fts WHERE rowid = ${row.id}`)
      tx.delete(chunkEmbeddings).where(eq(chunkEmbeddings.chunkId, row.id)).run()
    }
    tx.delete(chunks).where(eq(chunks.fileId, fileId)).run()

    for (const chunk of inputChunks) {
      const result = tx
        .insert(chunks)
        .values({
          repoKey: chunk.repoKey,
          fileId: chunk.fileId,
          path: chunk.path,
          packageKey: chunk.packageKey ?? null,
          language: chunk.language ?? null,
          chunkKind: chunk.chunkKind,
          symbolName: chunk.symbolName ?? null,
          symbolKind: chunk.symbolKind ?? null,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          contentHash: chunk.contentHash,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      const insertedChunkId = Number(result.lastInsertRowid)
      tx.run(sql`INSERT INTO chunk_fts(rowid, content, path, symbol_name) VALUES (${insertedChunkId}, ${chunk.content}, ${chunk.path}, ${chunk.symbolName ?? ''})`)
      inserted.push({ ...chunk, insertedChunkId })
    }
  })

  return inserted
}

export function deleteChunksForFilePaths(db: CodeIntelligenceDb, repoKey: string, paths: string[]): number {
  if (paths.length === 0) return 0
  let deleted = 0
  db.transaction((tx) => {
    for (const path of paths) {
      const rows = tx.select({ id: chunks.id }).from(chunks).where(and(eq(chunks.repoKey, repoKey), eq(chunks.path, path))).all()
      for (const row of rows) {
        tx.run(sql`DELETE FROM chunk_fts WHERE rowid = ${row.id}`)
        tx.delete(chunkEmbeddings).where(eq(chunkEmbeddings.chunkId, row.id)).run()
      }
      deleted += tx.delete(chunks).where(and(eq(chunks.repoKey, repoKey), eq(chunks.path, path))).run().changes
    }
  })
  return deleted
}

export function retrieveChunksFts(db: CodeIntelligenceDb, input: { repoKey: string; query: string; limit?: number; pathPrefix?: string }): RetrievedChunkRow[] {
  const query = sanitizeFtsQuery(input.query)
  if (!query) return []
  const limit = Math.max(1, Math.min(input.limit ?? 12, 50))
  const pathPrefix = input.pathPrefix ? `${input.pathPrefix}%` : null

  const rows = db.all(sql`SELECT
        c.id,
        c.repo_key,
        c.file_id,
        c.path,
        c.package_key,
        c.language,
        c.chunk_kind,
        c.symbol_name,
        c.symbol_kind,
        c.start_line,
        c.end_line,
        c.content,
        c.content_hash,
        bm25(chunk_fts) AS rank
      FROM chunk_fts
      JOIN chunks c ON c.id = chunk_fts.rowid
      JOIN files f ON f.id = c.file_id
      WHERE chunk_fts MATCH ${query}
        AND c.repo_key = ${input.repoKey}
        AND f.deleted_at IS NULL
        AND (${pathPrefix} IS NULL OR c.path LIKE ${pathPrefix})
      ORDER BY rank ASC
      LIMIT ${limit}`)
  return rows as RetrievedChunkRow[]
}

export function getChunksByIds(db: CodeIntelligenceDb, ids: number[]): ChunkRow[] {
  if (ids.length === 0) return []
  return db.select().from(chunks).where(inArray(chunks.id, ids)).all().map(chunkToRow)
}

export function getChunksForPaths(db: CodeIntelligenceDb, repoKey: string, paths: string[], limitPerPath = 4): ChunkRow[] {
  if (paths.length === 0) return []
  const rows: ChunkRow[] = []
  for (const path of paths) {
    rows.push(
      ...db
        .select({ chunk: chunks })
        .from(chunks)
        .innerJoin(files, eq(files.id, chunks.fileId))
        .where(and(eq(chunks.repoKey, repoKey), eq(chunks.path, path), isNull(files.deletedAt)))
        .orderBy(asc(chunks.startLine))
        .limit(limitPerPath)
        .all()
        .map((row) => chunkToRow(row.chunk))
    )
  }
  return rows
}

export function listChunksNeedingEmbedding(db: CodeIntelligenceDb, repoKey: string, limit = 1000): Array<ChunkInput & { insertedChunkId: number }> {
  const rows = db.all(sql`SELECT
        c.id,
        c.repo_key,
        c.file_id,
        c.path,
        c.package_key,
        c.language,
        c.chunk_kind,
        c.symbol_name,
        c.symbol_kind,
        c.start_line,
        c.end_line,
        c.content,
        c.content_hash
      FROM chunks c
      JOIN files f ON f.id = c.file_id
      LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id
      WHERE c.repo_key = ${repoKey}
        AND f.deleted_at IS NULL
        AND (e.chunk_id IS NULL OR e.stale = 1)
      ORDER BY c.updated_at DESC
      LIMIT ${limit}`) as ChunkRow[]
  return rows.map((row) => ({
    repoKey: row.repo_key,
    fileId: row.file_id,
    path: row.path,
    packageKey: row.package_key ?? undefined,
    language: row.language ?? undefined,
    chunkKind: row.chunk_kind,
    symbolName: row.symbol_name ?? undefined,
    symbolKind: row.symbol_kind ?? undefined,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    contentHash: row.content_hash,
    insertedChunkId: row.id,
  }))
}

export function getChunkStats(db: CodeIntelligenceDb, repoKey: string): { totalChunks: number; chunkedFiles: number; lastChunkedAt: string | null } {
  return db.get(sql`SELECT
        COUNT(*) AS totalChunks,
        COUNT(DISTINCT path) AS chunkedFiles,
        MAX(updated_at) AS lastChunkedAt
      FROM chunks
      WHERE repo_key = ${repoKey}`) as { totalChunks: number; chunkedFiles: number; lastChunkedAt: string | null }
}

function chunkToRow(row: typeof chunks.$inferSelect): ChunkRow {
  return {
    id: row.id,
    repo_key: row.repoKey,
    file_id: row.fileId,
    path: row.path,
    package_key: row.packageKey,
    language: row.language,
    chunk_kind: row.chunkKind,
    symbol_name: row.symbolName,
    symbol_kind: row.symbolKind,
    start_line: row.startLine,
    end_line: row.endLine,
    content: row.content,
    content_hash: row.contentHash,
  }
}

function sanitizeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim().replace(/[^\p{L}\p{N}_./:-]/gu, ''))
    .filter((term) => term.length >= 2)
    .slice(0, 12)

  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}
