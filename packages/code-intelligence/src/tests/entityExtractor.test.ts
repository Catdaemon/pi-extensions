import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_CONFIG } from '../config.ts'
import { openCodeIntelligenceDb } from '../db/connection.ts'
import { getEntityStats, listEntitiesForPath } from '../db/repositories/entitiesRepo.ts'
import { getIndexingState } from '../db/repositories/indexingStateRepo.ts'
import { extractEntitiesForFile } from '../indexing/entityExtractor.ts'
import { runFullRepoIndex, runIncrementalIndex } from '../indexing/indexScheduler.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import type { RepoIdentity } from '../repo/identifyRepo.ts'

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as CodeIntelligenceLogger

describe('entity extraction', () => {
  it('extracts TS/JS declarations, React components, hooks, tests, and import metadata', () => {
    const entities = extractEntitiesForFile({
      repoKey: 'repo',
      fileId: 1,
      path: 'src/App.tsx',
      packageKey: 'root',
      language: 'typescriptreact',
      content: [
        "import React, { useMemo } from 'react'",
        "import type { User } from './types'",
        'export interface Props { user: User }',
        'export type Mode = "a" | "b"',
        'export function useThing() { return useMemo(() => 1, []) }',
        'export const AppScreen = (props: Props) => {',
        '  return <View />',
        '}',
        'const valueSchema = {}',
        "describe('app screen', () => {",
        "  test('renders', () => {})",
        '})',
      ].join('\n'),
    })

    assert(entities.some((entity) => entity.name === 'src/App.tsx' && entity.kind === 'module' && JSON.stringify(entity.metadata).includes('react')))
    assert(entities.some((entity) => entity.name === 'Props' && entity.kind === 'interface' && entity.exported))
    assert(entities.some((entity) => entity.name === 'Mode' && entity.kind === 'type'))
    assert(entities.some((entity) => entity.name === 'useThing' && entity.kind === 'hook'))
    assert(entities.some((entity) => entity.name === 'AppScreen' && entity.kind === 'screen'))
    assert(entities.some((entity) => entity.name === 'valueSchema' && entity.kind === 'schema'))
    assert(entities.some((entity) => entity.name === 'app screen' && entity.kind === 'test_suite'))
  })

  it('extracts JavaScript separately, including CommonJS imports', () => {
    const entities = extractEntitiesForFile({
      repoKey: 'repo',
      fileId: 1,
      path: 'src/widget.jsx',
      language: 'javascriptreact',
      content: [
        "const React = require('react')",
        "import Button from './Button'",
        'export function Widget() {',
        '  return <Button />',
        '}',
      ].join('\n'),
    })

    assert(entities.some((entity) => entity.name === 'Widget' && entity.kind === 'component'))
    const moduleEntity = entities.find((entity) => entity.name === 'src/widget.jsx')
    assert(JSON.stringify(moduleEntity?.metadata).includes('react'))
    assert(JSON.stringify(moduleEntity?.metadata).includes('./Button'))
  })

  it('stores entities during indexing, replaces them on change, and deletes them on file deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-entities-'))
    const storage = await mkdtemp(join(tmpdir(), 'pi-code-intelligence-entities-db-'))
    const db = await openCodeIntelligenceDb(storage)
    try {
      await mkdir(join(root, 'src'), { recursive: true })
      await writeFile(join(root, 'src', 'app.tsx'), 'export function useThing() { return 1 }\nexport const App = () => <View />\n')
      const identity: RepoIdentity = { repoKey: 'entities-repo', gitRoot: root, identitySource: 'path' }
      const config = { ...DEFAULT_CONFIG, include: ['src/**'] }

      await runFullRepoIndex({ identity, db, config, logger: silentLogger }, 'test')
      assert.equal(getEntityStats(db, identity.repoKey).byKind.hook, 1)
      assert.equal(getEntityStats(db, identity.repoKey).byKind.component, 1)
      assert(getIndexingState(db)?.progress_entities_extracted! >= 2)

      await writeFile(join(root, 'src', 'app.tsx'), 'export class App {}\n')
      await runIncrementalIndex({ identity, db, config, logger: silentLogger }, { changedPaths: ['src/app.tsx'], deletedPaths: [], reason: 'test' })
      const changedEntities = listEntitiesForPath(db, identity.repoKey, 'src/app.tsx')
      assert(changedEntities.some((entity) => entity.name === 'App' && entity.kind === 'class'))
      assert.equal(changedEntities.some((entity) => entity.name === 'useThing'), false)

      await rm(join(root, 'src', 'app.tsx'))
      await runIncrementalIndex({ identity, db, config, logger: silentLogger }, { changedPaths: [], deletedPaths: ['src/app.tsx'], reason: 'test' })
      assert.equal(listEntitiesForPath(db, identity.repoKey, 'src/app.tsx').length, 0)
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
      await rm(storage, { recursive: true, force: true })
    }
  })
})
