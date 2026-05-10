import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { IndexScheduler } from '../indexing/indexScheduler.ts'
import { CodeIntelligenceLogger } from '../logger.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

const silentLogger = new CodeIntelligenceLogger('pi-code-intelligence-test', 'silent')

describe('index scheduler worker locks', () => {
  it('does not remove a worker start lock it did not acquire', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-worker-lock-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      const lockDir = join(storage, 'worker-start.lock')
      await mkdir(lockDir)
      await writeFile(join(lockDir, 'owner-pid'), '999999\n', 'utf8')
      const identity: RepoIdentity = { repoKey: 'worker-lock-repo', gitRoot: storage, identitySource: 'path' }
      const scheduler = new IndexScheduler({ identity, db, config: DEFAULT_CONFIG, logger: silentLogger, dbStorageDir: storage })

      await scheduler.cancelActiveWorker(1)

      assert.equal(await readFile(join(lockDir, 'owner-pid'), 'utf8'), '999999\n')
    } finally {
      db.close()
      await rm(storage, { recursive: true, force: true })
    }
  })
})
