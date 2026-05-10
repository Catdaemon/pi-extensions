import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  disableCodeIntelligenceRepo,
  enableCodeIntelligenceRepo,
  getEnabledRepoRecord,
  isCodeIntelligenceEnabled,
  resolveEnabledReposDbPath,
} from '../repo/enabledRepos.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

describe('code intelligence enablement state', () => {
  it('is disabled by default and enables explicitly per repo key', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-test-'))
    const env = { XDG_DATA_HOME: temp } as NodeJS.ProcessEnv

    try {
      const identity: RepoIdentity = {
        repoKey: 'repo123',
        originUrl: 'git@github.com:org/repo.git',
        normalizedOriginUrl: 'github.com/org/repo',
        gitRoot: '/workspace/repo',
        defaultBranch: 'main',
        identitySource: 'origin',
      }

      assert.equal(resolveEnabledReposDbPath(env), join(temp, 'pi-code-intelligence', 'global.sqlite'))
      assert.equal(await isCodeIntelligenceEnabled(identity.repoKey, env), false)
      assert.equal(await getEnabledRepoRecord(identity.repoKey, env), undefined)

      const enabled = await enableCodeIntelligenceRepo(identity, env)
      assert.equal(enabled.repoKey, identity.repoKey)
      assert.equal(await isCodeIntelligenceEnabled(identity.repoKey, env), true)
      assert.equal((await getEnabledRepoRecord(identity.repoKey, env))?.normalizedOriginUrl, 'github.com/org/repo')

      assert.equal(await disableCodeIntelligenceRepo(identity.repoKey, env), true)
      assert.equal(await isCodeIntelligenceEnabled(identity.repoKey, env), false)
      assert.equal(await disableCodeIntelligenceRepo(identity.repoKey, env), false)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})
