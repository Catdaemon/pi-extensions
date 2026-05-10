import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ensureCodeIntelligenceInstall, formatInstallStatus } from '../lifecycle/install.ts'

describe('code intelligence install bootstrap', () => {
  it('creates data, model, and global database paths automatically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-install-'))
    const env = { XDG_DATA_HOME: root }
    try {
      const status = await ensureCodeIntelligenceInstall(undefined, env)
      assert.equal(status.dataDir, join(root, 'pi-code-intelligence'))
      assert.equal(status.modelCacheDir, join(root, 'pi-code-intelligence', 'models'))
      assert.equal(status.globalDbPath, join(root, 'pi-code-intelligence', 'global.sqlite'))
      assert.equal(existsSync(status.dataDir), true)
      assert.equal(existsSync(status.modelCacheDir), true)
      assert.equal(existsSync(status.globalDbPath), true)
      assert(status.checks.some((check) => check.name === 'global_db' && check.ok))
      assert(formatInstallStatus(status).includes('Code intelligence install status'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
