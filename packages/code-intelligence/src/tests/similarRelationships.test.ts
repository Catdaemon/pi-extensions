import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { getRelationshipStats, listCodeRelationshipsForPath } from '../db/repositories/relationshipsRepo.ts'
import { MockEmbeddingService } from '../embeddings/mockEmbeddingService.ts'
import { runFullRepoIndex } from '../indexing/indexScheduler.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as CodeIntelligenceLogger

describe('similar relationships', () => {
  it('refreshes bounded similar_to relationships after embedding indexing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-similar-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-similar-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'invoice.ts'), 'export function formatInvoiceTotal(total: number) {\n  return `Invoice total: ${total}`\n}\n')
      await writeFile(join(root, 'src', 'receipt.ts'), 'export function formatReceiptTotal(total: number) {\n  return `Invoice total: ${total}`\n}\n')
      await writeFile(join(root, 'src', 'user.ts'), 'export function loadUserName(name: string) {\n  return name.toUpperCase()\n}\n')
      const identity: RepoIdentity = { repoKey: 'similar-repo', gitRoot: root, identitySource: 'path' }
      await runFullRepoIndex({ identity, db, config: { ...DEFAULT_CONFIG, include: ['src/**'] }, logger: silentLogger, embeddingService: new MockEmbeddingService(64) }, 'test')

      assert((getRelationshipStats(db, identity.repoKey).byKind.similar_to ?? 0) > 0)
      const invoiceRelationships = listCodeRelationshipsForPath(db, identity.repoKey, 'src/invoice.ts')
      const receiptSimilarity = invoiceRelationships.find((rel) => rel.kind === 'similar_to' && rel.targetPath === 'src/receipt.ts')
      assert(receiptSimilarity)
      const metadata = JSON.parse(receiptSimilarity.metadataJson ?? '{}') as { boosts?: string[]; similarity?: number; score?: number }
      assert(metadata.boosts?.includes('same_symbol_kind'))
      assert(metadata.boosts?.includes('same_chunk_kind'))
      assert((metadata.score ?? 0) >= (metadata.similarity ?? 0))
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})
