import { sql } from 'drizzle-orm'
import { codeIntelligenceMigrations } from './schema.ts'
import type { CodeIntelligenceDb } from './connection.ts'

export type DrizzleMigration = {
  id: number
  name: string
  statements: string[]
}

export const DRIZZLE_MIGRATIONS: DrizzleMigration[] = [
  {
    id: 1,
    name: 'initial_drizzle_schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS repo_metadata (
        repo_key TEXT PRIMARY KEY,
        origin_url TEXT,
        normalized_origin_url TEXT,
        git_root TEXT,
        default_branch TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS enabled_repos (
        repo_key TEXT PRIMARY KEY,
        origin_url TEXT,
        normalized_origin_url TEXT,
        git_root TEXT NOT NULL,
        default_branch TEXT,
        enabled_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_key TEXT NOT NULL,
        package_key TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT,
        manager TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_key, package_key)
      )`,
      `CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_key TEXT NOT NULL,
        package_key TEXT,
        path TEXT NOT NULL,
        language TEXT,
        file_hash TEXT NOT NULL,
        size_bytes INTEGER,
        is_generated INTEGER NOT NULL DEFAULT 0,
        generated_reason TEXT,
        last_indexed_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(repo_key, path)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_files_repo_path ON files(repo_key, path)`,
      `CREATE INDEX IF NOT EXISTS idx_files_hash ON files(file_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_files_package ON files(repo_key, package_key)`,
      `CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_key TEXT NOT NULL,
        file_id INTEGER NOT NULL REFERENCES files(id),
        path TEXT NOT NULL,
        package_key TEXT,
        language TEXT,
        chunk_kind TEXT NOT NULL,
        symbol_name TEXT,
        symbol_kind TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding_model TEXT,
        embedding_dimensions INTEGER,
        embedding_version TEXT,
        embedding_text_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_key, path, content_hash)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chunks_repo_path ON chunks(repo_key, path)`,
      `CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id)`,
      `CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(repo_key, symbol_name)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(content, path, symbol_name, tokenize='porter unicode61')`,
      `CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id),
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding_version TEXT NOT NULL,
        embedding_text_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model_stale ON chunk_embeddings(model, stale)`,
      `CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        repo_key TEXT NOT NULL,
        package_key TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        applies_when TEXT NOT NULL,
        avoid TEXT,
        prefer TEXT,
        path_globs_json TEXT,
        languages_json TEXT,
        examples_json TEXT,
        source_kind TEXT NOT NULL,
        source_ref TEXT,
        source_timestamp TEXT NOT NULL,
        confidence REAL NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        embedding_text TEXT NOT NULL,
        embedding_model TEXT,
        embedding_dimensions INTEGER,
        embedding_version TEXT,
        embedding_text_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        superseded_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_learnings_repo_status ON learnings(repo_key, status)`,
      `CREATE INDEX IF NOT EXISTS idx_learnings_repo_package ON learnings(repo_key, package_key)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS learning_fts USING fts5(
        title,
        summary,
        applies_when,
        avoid,
        prefer,
        embedding_text,
        learning_id UNINDEXED,
        tokenize='porter unicode61'
      )`,
      `CREATE TABLE IF NOT EXISTS learning_embeddings (
        learning_id TEXT PRIMARY KEY REFERENCES learnings(id),
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding_version TEXT NOT NULL,
        embedding_text_hash TEXT NOT NULL,
        embedding BLOB NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_learning_embeddings_model_stale ON learning_embeddings(model, stale)`,
      `CREATE TABLE IF NOT EXISTS machine_rules (
        id TEXT PRIMARY KEY,
        learning_id TEXT NOT NULL REFERENCES learnings(id),
        repo_key TEXT NOT NULL,
        rule_kind TEXT NOT NULL,
        pattern TEXT NOT NULL,
        message TEXT NOT NULL,
        path_globs_json TEXT,
        languages_json TEXT,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY,
        learning_id TEXT REFERENCES learnings(id),
        repo_key TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS indexing_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        repo_key TEXT NOT NULL,
        full_index_completed_at TEXT,
        last_incremental_index_at TEXT,
        active_embedding_model TEXT,
        active_embedding_dimensions INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS embedding_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL,
        active_model TEXT,
        active_dimensions INTEGER,
        status TEXT NOT NULL,
        cache_dir TEXT NOT NULL,
        last_error TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    id: 2,
    name: 'indexing_progress_metadata',
    statements: [
      `ALTER TABLE indexing_state ADD COLUMN progress_phase TEXT`,
      `ALTER TABLE indexing_state ADD COLUMN progress_current_path TEXT`,
      `ALTER TABLE indexing_state ADD COLUMN progress_recent_paths_json TEXT`,
      `ALTER TABLE indexing_state ADD COLUMN progress_files_scanned INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE indexing_state ADD COLUMN progress_entities_extracted INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE indexing_state ADD COLUMN progress_relationships_extracted INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE indexing_state ADD COLUMN progress_started_at TEXT`,
      `ALTER TABLE indexing_state ADD COLUMN progress_updated_at TEXT`,
    ],
  },
  {
    id: 3,
    name: 'graph_schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS code_entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_key TEXT NOT NULL,
        file_id INTEGER NOT NULL REFERENCES files(id),
        path TEXT NOT NULL,
        package_key TEXT,
        name TEXT NOT NULL,
        qualified_name TEXT,
        kind TEXT NOT NULL,
        symbol_kind TEXT,
        exported INTEGER NOT NULL DEFAULT 0,
        default_export INTEGER NOT NULL DEFAULT 0,
        start_line INTEGER,
        end_line INTEGER,
        signature TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_key, path, name, kind, start_line)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_code_entities_repo_path ON code_entities(repo_key, path)`,
      `CREATE INDEX IF NOT EXISTS idx_code_entities_repo_name ON code_entities(repo_key, name)`,
      `CREATE INDEX IF NOT EXISTS idx_code_entities_repo_qualified_name ON code_entities(repo_key, qualified_name)`,
      `CREATE INDEX IF NOT EXISTS idx_code_entities_repo_kind ON code_entities(repo_key, kind)`,
      `CREATE TABLE IF NOT EXISTS code_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_key TEXT NOT NULL,
        source_entity_id INTEGER REFERENCES code_entities(id),
        target_entity_id INTEGER REFERENCES code_entities(id),
        source_path TEXT NOT NULL,
        target_path TEXT,
        source_name TEXT,
        target_name TEXT,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_code_relationships_source_path ON code_relationships(repo_key, source_path)`,
      `CREATE INDEX IF NOT EXISTS idx_code_relationships_target_path ON code_relationships(repo_key, target_path)`,
      `CREATE INDEX IF NOT EXISTS idx_code_relationships_kind ON code_relationships(repo_key, kind)`,
      `CREATE INDEX IF NOT EXISTS idx_code_relationships_source_entity ON code_relationships(repo_key, source_entity_id)`,
      `CREATE INDEX IF NOT EXISTS idx_code_relationships_target_entity ON code_relationships(repo_key, target_entity_id)`,
      `CREATE INDEX IF NOT EXISTS idx_code_relationships_target_name ON code_relationships(repo_key, target_name)`,
      `CREATE TABLE IF NOT EXISTS file_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_key TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence REAL NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_file_relationships_source_path ON file_relationships(repo_key, source_path)`,
      `CREATE INDEX IF NOT EXISTS idx_file_relationships_target_path ON file_relationships(repo_key, target_path)`,
      `CREATE INDEX IF NOT EXISTS idx_file_relationships_kind ON file_relationships(repo_key, kind)`,
    ],
  },
  {
    id: 4,
    name: 'embedding_active_device',
    statements: [
      `ALTER TABLE embedding_status ADD COLUMN active_device TEXT`,
    ],
  },
  {
    id: 5,
    name: 'embedding_download_progress',
    statements: [
      `ALTER TABLE embedding_status ADD COLUMN download_status TEXT`,
      `ALTER TABLE embedding_status ADD COLUMN download_file TEXT`,
      `ALTER TABLE embedding_status ADD COLUMN download_loaded_bytes INTEGER`,
      `ALTER TABLE embedding_status ADD COLUMN download_total_bytes INTEGER`,
      `ALTER TABLE embedding_status ADD COLUMN download_progress INTEGER`,
    ],
  },
  {
    id: 6,
    name: 'embedding_throughput_eta',
    statements: [
      `ALTER TABLE embedding_status ADD COLUMN embedding_rate_per_second INTEGER`,
      `ALTER TABLE embedding_status ADD COLUMN embedding_eta_seconds INTEGER`,
    ],
  },
]

export function runDrizzleMigrations(db: CodeIntelligenceDb): void {
  db.run(sql`PRAGMA foreign_keys = ON`)
  db.run(sql`CREATE TABLE IF NOT EXISTS code_intelligence_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`)

  const applied = new Set(db.select({ id: codeIntelligenceMigrations.id }).from(codeIntelligenceMigrations).all().map((row) => row.id))
  for (const migration of DRIZZLE_MIGRATIONS) {
    if (applied.has(migration.id)) continue
    db.transaction((tx) => {
      for (const statement of migration.statements) {
        try {
          tx.run(sql.raw(statement))
        } catch (error) {
          if (!isDuplicateColumnError(error)) throw error
        }
      }
      tx.insert(codeIntelligenceMigrations).values({ id: migration.id, name: migration.name, appliedAt: new Date().toISOString() }).run()
    })
  }
}

function isDuplicateColumnError(error: unknown): boolean {
  return /duplicate column name/i.test((error as Error).message ?? '')
}
