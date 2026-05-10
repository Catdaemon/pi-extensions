import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const repoMetadata = sqliteTable('repo_metadata', {
  repoKey: text('repo_key').primaryKey(),
  originUrl: text('origin_url'),
  normalizedOriginUrl: text('normalized_origin_url'),
  gitRoot: text('git_root'),
  defaultBranch: text('default_branch'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const enabledRepos = sqliteTable('enabled_repos', {
  repoKey: text('repo_key').primaryKey(),
  originUrl: text('origin_url'),
  normalizedOriginUrl: text('normalized_origin_url'),
  gitRoot: text('git_root').notNull(),
  defaultBranch: text('default_branch'),
  enabledAt: text('enabled_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
})

export const packages = sqliteTable('packages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoKey: text('repo_key').notNull(),
  packageKey: text('package_key').notNull(),
  path: text('path').notNull(),
  name: text('name'),
  manager: text('manager'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  repoPackage: uniqueIndex('idx_packages_repo_package_unique').on(table.repoKey, table.packageKey),
}))

export const files = sqliteTable('files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoKey: text('repo_key').notNull(),
  packageKey: text('package_key'),
  path: text('path').notNull(),
  language: text('language'),
  fileHash: text('file_hash').notNull(),
  sizeBytes: integer('size_bytes'),
  isGenerated: integer('is_generated').notNull().default(0),
  generatedReason: text('generated_reason'),
  lastIndexedAt: text('last_indexed_at').notNull(),
  deletedAt: text('deleted_at'),
}, (table) => ({
  repoPath: uniqueIndex('idx_files_repo_path_unique').on(table.repoKey, table.path),
  path: index('idx_files_repo_path').on(table.repoKey, table.path),
  hash: index('idx_files_hash').on(table.fileHash),
  package: index('idx_files_package').on(table.repoKey, table.packageKey),
}))

export const chunks = sqliteTable('chunks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoKey: text('repo_key').notNull(),
  fileId: integer('file_id').notNull().references(() => files.id),
  path: text('path').notNull(),
  packageKey: text('package_key'),
  language: text('language'),
  chunkKind: text('chunk_kind').notNull(),
  symbolName: text('symbol_name'),
  symbolKind: text('symbol_kind'),
  startLine: integer('start_line').notNull(),
  endLine: integer('end_line').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  embeddingModel: text('embedding_model'),
  embeddingDimensions: integer('embedding_dimensions'),
  embeddingVersion: text('embedding_version'),
  embeddingTextHash: text('embedding_text_hash'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  repoPathHash: uniqueIndex('idx_chunks_repo_path_hash_unique').on(table.repoKey, table.path, table.contentHash),
  repoPath: index('idx_chunks_repo_path').on(table.repoKey, table.path),
  file: index('idx_chunks_file').on(table.fileId),
  symbol: index('idx_chunks_symbol').on(table.repoKey, table.symbolName),
}))

export const codeEntities = sqliteTable('code_entities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoKey: text('repo_key').notNull(),
  fileId: integer('file_id').notNull().references(() => files.id),
  path: text('path').notNull(),
  packageKey: text('package_key'),
  name: text('name').notNull(),
  qualifiedName: text('qualified_name'),
  kind: text('kind').notNull(),
  symbolKind: text('symbol_kind'),
  exported: integer('exported').notNull().default(0),
  defaultExport: integer('default_export').notNull().default(0),
  startLine: integer('start_line'),
  endLine: integer('end_line'),
  signature: text('signature'),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  repoPath: index('idx_code_entities_repo_path').on(table.repoKey, table.path),
  repoName: index('idx_code_entities_repo_name').on(table.repoKey, table.name),
  repoQualifiedName: index('idx_code_entities_repo_qualified_name').on(table.repoKey, table.qualifiedName),
  repoKind: index('idx_code_entities_repo_kind').on(table.repoKey, table.kind),
  identity: uniqueIndex('idx_code_entities_identity_unique').on(table.repoKey, table.path, table.name, table.kind, table.startLine),
}))

export const codeRelationships = sqliteTable('code_relationships', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoKey: text('repo_key').notNull(),
  sourceEntityId: integer('source_entity_id').references(() => codeEntities.id),
  targetEntityId: integer('target_entity_id').references(() => codeEntities.id),
  sourcePath: text('source_path').notNull(),
  targetPath: text('target_path'),
  sourceName: text('source_name'),
  targetName: text('target_name'),
  kind: text('kind').notNull(),
  confidence: real('confidence').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  sourcePath: index('idx_code_relationships_source_path').on(table.repoKey, table.sourcePath),
  targetPath: index('idx_code_relationships_target_path').on(table.repoKey, table.targetPath),
  kind: index('idx_code_relationships_kind').on(table.repoKey, table.kind),
  sourceEntity: index('idx_code_relationships_source_entity').on(table.repoKey, table.sourceEntityId),
  targetEntity: index('idx_code_relationships_target_entity').on(table.repoKey, table.targetEntityId),
  targetName: index('idx_code_relationships_target_name').on(table.repoKey, table.targetName),
}))

export const fileRelationships = sqliteTable('file_relationships', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoKey: text('repo_key').notNull(),
  sourcePath: text('source_path').notNull(),
  targetPath: text('target_path').notNull(),
  kind: text('kind').notNull(),
  confidence: real('confidence').notNull(),
  metadataJson: text('metadata_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  sourcePath: index('idx_file_relationships_source_path').on(table.repoKey, table.sourcePath),
  targetPath: index('idx_file_relationships_target_path').on(table.repoKey, table.targetPath),
  kind: index('idx_file_relationships_kind').on(table.repoKey, table.kind),
}))

export const chunkEmbeddings = sqliteTable('chunk_embeddings', {
  chunkId: integer('chunk_id').primaryKey().references(() => chunks.id),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  embeddingVersion: text('embedding_version').notNull(),
  embeddingTextHash: text('embedding_text_hash').notNull(),
  embedding: blob('embedding', { mode: 'buffer' }).notNull(),
  stale: integer('stale').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  modelStale: index('idx_chunk_embeddings_model_stale').on(table.model, table.stale),
}))

export const learnings = sqliteTable('learnings', {
  id: text('id').primaryKey(),
  repoKey: text('repo_key').notNull(),
  packageKey: text('package_key'),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  ruleType: text('rule_type').notNull(),
  appliesWhen: text('applies_when').notNull(),
  avoid: text('avoid'),
  prefer: text('prefer'),
  pathGlobsJson: text('path_globs_json'),
  languagesJson: text('languages_json'),
  examplesJson: text('examples_json'),
  sourceKind: text('source_kind').notNull(),
  sourceRef: text('source_ref'),
  sourceTimestamp: text('source_timestamp').notNull(),
  confidence: real('confidence').notNull(),
  priority: integer('priority').notNull(),
  status: text('status').notNull(),
  embeddingText: text('embedding_text').notNull(),
  embeddingModel: text('embedding_model'),
  embeddingDimensions: integer('embedding_dimensions'),
  embeddingVersion: text('embedding_version'),
  embeddingTextHash: text('embedding_text_hash'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastUsedAt: text('last_used_at'),
  supersededBy: text('superseded_by'),
}, (table) => ({
  repoStatus: index('idx_learnings_repo_status').on(table.repoKey, table.status),
  repoPackage: index('idx_learnings_repo_package').on(table.repoKey, table.packageKey),
}))

export const learningEmbeddings = sqliteTable('learning_embeddings', {
  learningId: text('learning_id').primaryKey().references(() => learnings.id),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  embeddingVersion: text('embedding_version').notNull(),
  embeddingTextHash: text('embedding_text_hash').notNull(),
  embedding: blob('embedding', { mode: 'buffer' }).notNull(),
  stale: integer('stale').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  modelStale: index('idx_learning_embeddings_model_stale').on(table.model, table.stale),
}))

export const machineRules = sqliteTable('machine_rules', {
  id: text('id').primaryKey(),
  learningId: text('learning_id').notNull().references(() => learnings.id),
  repoKey: text('repo_key').notNull(),
  ruleKind: text('rule_kind').notNull(),
  pattern: text('pattern').notNull(),
  message: text('message').notNull(),
  pathGlobsJson: text('path_globs_json'),
  languagesJson: text('languages_json'),
  severity: text('severity').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const learningEvents = sqliteTable('learning_events', {
  id: text('id').primaryKey(),
  learningId: text('learning_id').references(() => learnings.id),
  repoKey: text('repo_key').notNull(),
  eventKind: text('event_kind').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdAt: text('created_at').notNull(),
})

export const indexingState = sqliteTable('indexing_state', {
  id: integer('id').primaryKey(),
  repoKey: text('repo_key').notNull(),
  fullIndexCompletedAt: text('full_index_completed_at'),
  lastIncrementalIndexAt: text('last_incremental_index_at'),
  activeEmbeddingModel: text('active_embedding_model'),
  activeEmbeddingDimensions: integer('active_embedding_dimensions'),
  progressPhase: text('progress_phase'),
  progressCurrentPath: text('progress_current_path'),
  progressRecentPathsJson: text('progress_recent_paths_json'),
  progressFilesScanned: integer('progress_files_scanned').notNull().default(0),
  progressEntitiesExtracted: integer('progress_entities_extracted').notNull().default(0),
  progressRelationshipsExtracted: integer('progress_relationships_extracted').notNull().default(0),
  progressStartedAt: text('progress_started_at'),
  progressUpdatedAt: text('progress_updated_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const embeddingStatus = sqliteTable('embedding_status', {
  id: integer('id').primaryKey(),
  provider: text('provider').notNull(),
  activeModel: text('active_model'),
  activeDimensions: integer('active_dimensions'),
  status: text('status').notNull(),
  cacheDir: text('cache_dir').notNull(),
  lastError: text('last_error'),
  lastCheckedAt: text('last_checked_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const codeIntelligenceMigrations = sqliteTable('code_intelligence_migrations', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  appliedAt: text('applied_at').notNull(),
})

export const schema = {
  repoMetadata,
  enabledRepos,
  packages,
  files,
  chunks,
  codeEntities,
  codeRelationships,
  fileRelationships,
  chunkEmbeddings,
  learnings,
  learningEmbeddings,
  machineRules,
  learningEvents,
  indexingState,
  embeddingStatus,
  codeIntelligenceMigrations,
}
