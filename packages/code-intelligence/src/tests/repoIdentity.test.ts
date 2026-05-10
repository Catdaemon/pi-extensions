import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { computeRepoKey } from '../repo/identifyRepo.ts'
import { normalizeRemoteUrl } from '../repo/normalizeRemoteUrl.ts'
import { resolveCodeIntelligenceDataDir, resolveRepoStorageDir, resolveXdgDataHome } from '../repo/storage.ts'

describe('normalizeRemoteUrl', () => {
  it('normalizes common GitHub remote URL forms to the same repo identity', () => {
    const expected = 'github.com/org/repo'
    const variants = [
      'git@github.com:org/repo.git',
      'https://github.com/org/repo.git',
      'https://github.com/org/repo',
      'ssh://git@github.com/org/repo.git',
      'HTTPS://GitHub.com/Org/Repo.git',
    ]

    for (const variant of variants) {
      assert.equal(normalizeRemoteUrl(variant), expected)
    }
  })

  it('trims trailing slashes and .git suffixes', () => {
    assert.equal(normalizeRemoteUrl('https://github.com/org/repo.git/'), 'github.com/org/repo')
  })
})

describe('computeRepoKey', () => {
  it('is sha256 of the normalized origin URL', () => {
    const normalized = normalizeRemoteUrl('git@github.com:org/repo.git')
    const expected = createHash('sha256').update('github.com/org/repo').digest('hex')
    assert.equal(computeRepoKey(normalized), expected)
  })

  it('gives the same key for equivalent remote URL forms', () => {
    const a = computeRepoKey(normalizeRemoteUrl('git@github.com:org/repo.git'))
    const b = computeRepoKey(normalizeRemoteUrl('https://github.com/org/repo'))
    assert.equal(a, b)
  })
})

describe('storage path resolution', () => {
  it('uses XDG_DATA_HOME when set', () => {
    const env = { XDG_DATA_HOME: '/tmp/xdg-data' } as NodeJS.ProcessEnv
    assert.equal(resolveXdgDataHome(env), '/tmp/xdg-data')
    assert.equal(resolveCodeIntelligenceDataDir(env), '/tmp/xdg-data/pi-code-intelligence')
    assert.equal(resolveRepoStorageDir('abc123', env), '/tmp/xdg-data/pi-code-intelligence/repos/abc123')
  })

  it('falls back to ~/.local/share and never uses macOS Application Support', () => {
    const env = {} as NodeJS.ProcessEnv
    const expectedDataHome = join(homedir(), '.local', 'share')
    assert.equal(resolveXdgDataHome(env), expectedDataHome)
    assert.equal(resolveRepoStorageDir('abc123', env), join(expectedDataHome, 'pi-code-intelligence', 'repos', 'abc123'))
    assert(!resolveRepoStorageDir('abc123', env).includes('Application Support'))
  })
})
