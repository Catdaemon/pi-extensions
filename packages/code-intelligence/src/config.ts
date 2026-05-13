import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ReviewConfigRule = {
  id: string
  severity: 'error' | 'warning' | 'info'
  scope?: string[]
  instruction: string
}

export type ReviewConfigStatus = {
  filesLoaded: string[]
  errors: string[]
}

export const REVIEW_PASSES = ['triage', 'tests', 'aiSlop', 'correctness', 'security', 'verifier'] as const
export const CHEAP_REVIEW_PASSES = ['triage', 'tests', 'aiSlop'] as const
export const DEFAULT_MODEL_REVIEW_PASSES = ['correctness', 'security', 'verifier'] as const
export type ReviewPass = typeof REVIEW_PASSES[number]

export type ReviewModelRoutingConfig = {
  strategy: 'inherit' | 'same-family-cheap' | 'explicit'
  allowCrossProvider: boolean
  models: Partial<Record<ReviewPass | 'default', string>>
}

export type CodeIntelligenceConfig = {
  include: string[]
  exclude: string[]
  packages: Array<{ key: string; path: string }>
  generatedPaths: string[]
  testPaths: string[]
  embedding: {
    model: string
    fallbackModel: string
    emergencyFallbackModel: string
    autoDownload: boolean
    batchSize: number
    batchSizeByDevice: Partial<Record<'cpu' | 'gpu' | 'webgpu' | 'coreml' | 'cuda' | 'dml' | 'auto', number>>
    maxConcurrentBatches: number
    pauseWhenOnBattery: boolean
    lowPriority: boolean
    modelCacheDir: string
    device: 'auto' | 'cpu' | 'gpu' | 'webgpu' | 'coreml' | 'cuda' | 'dml'
    dtype: 'auto' | 'fp32' | 'fp16' | 'q8' | 'q4'
  }
  indexing: {
    scanConcurrency: number
    transactionBatchSize: number
    progressIntervalMs: number
    progressFileInterval: number
    fullRelationshipRefresh: 'changed' | 'all' | 'disabled'
  }
  maxFileBytes: number
  maxCodeChunks: number
  maxLearnings: number
  maxChunkChars: number
  maxLearningChars: number
  maxTotalContextChars: number
  review: {
    rules: ReviewConfigRule[]
    status: ReviewConfigStatus
    modelRouting: ReviewModelRoutingConfig
  }
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'vendor',
  '**/vendor/**',
  'tmp',
  '**/tmp/**',
  'logs',
  '**/logs/**',
  'ios/Pods/**',
  'android/.gradle/**',
  'android/build/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/target/**',
  '**/*.lock',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/*.min.js',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
]

export const DEFAULT_CONFIG: CodeIntelligenceConfig = {
  include: ['**/*'],
  exclude: [...DEFAULT_EXCLUDE_PATTERNS],
  packages: [],
  generatedPaths: ['src/generated/**', 'packages/**/src/generated/**'],
  testPaths: ['test/**', '**/*.test.ts', '**/*.spec.ts'],
  embedding: {
    model: 'onnx-community/bge-small-en-v1.5-ONNX',
    fallbackModel: 'onnx-community/bge-small-en-v1.5-ONNX',
    emergencyFallbackModel: 'onnx-community/bge-small-en-v1.5-ONNX',
    autoDownload: true,
    batchSize: 8,
    batchSizeByDevice: {
      cpu: 8,
      coreml: 32,
      webgpu: 32,
      gpu: 32,
      cuda: 64,
      dml: 32,
      auto: 16,
    },
    maxConcurrentBatches: 1,
    pauseWhenOnBattery: false,
    lowPriority: true,
    modelCacheDir: '$XDG_DATA_HOME/pi-code-intelligence/models',
    device: 'cpu',
    dtype: 'auto',
  },
  indexing: {
    scanConcurrency: 4,
    transactionBatchSize: 100,
    progressIntervalMs: 1000,
    progressFileInterval: 100,
    fullRelationshipRefresh: 'changed',
  },
  maxFileBytes: 300_000,
  maxCodeChunks: 12,
  maxLearnings: 8,
  maxChunkChars: 6_000,
  maxLearningChars: 1_200,
  maxTotalContextChars: 50_000,
  review: {
    rules: [],
    status: { filesLoaded: [], errors: [] },
    modelRouting: {
      strategy: 'same-family-cheap',
      allowCrossProvider: false,
      models: {},
    },
  },
}

export async function loadConfig(repoRoot: string): Promise<CodeIntelligenceConfig> {
  const config = cloneDefaultConfig()
  const gitignorePatterns = await loadGitignoreExcludePatterns(repoRoot)
  if (gitignorePatterns.length > 0) {
    config.exclude = [...new Set([...config.exclude, ...gitignorePatterns])]
  }
  await applyRepoLocalConfig(repoRoot, config)
  return config
}

async function applyRepoLocalConfig(repoRoot: string, config: CodeIntelligenceConfig): Promise<void> {
  for (const relativePath of ['.pi-code-intelligence.json', '.pi/code-intelligence.json']) {
    try {
      const content = await readFile(join(repoRoot, relativePath), 'utf8')
      const parsed = JSON.parse(content) as Partial<CodeIntelligenceConfig> & { reviewRules?: ReviewConfigRule[] }
      mergeStringArray(config, 'include', parsed.include)
      mergeStringArray(config, 'exclude', parsed.exclude)
      mergeStringArray(config, 'generatedPaths', parsed.generatedPaths)
      mergeStringArray(config, 'testPaths', parsed.testPaths)
      if (Array.isArray(parsed.packages)) config.packages = parsed.packages.filter((item) => item && typeof item.key === 'string' && typeof item.path === 'string')
      if (parsed.embedding && typeof parsed.embedding === 'object') config.embedding = sanitizeEmbeddingConfig({ ...config.embedding, ...parsed.embedding })
      if (parsed.indexing && typeof parsed.indexing === 'object') config.indexing = sanitizeIndexingConfig({ ...config.indexing, ...parsed.indexing })
      if (parsed.review?.rules || parsed.reviewRules) config.review.rules = sanitizeReviewRules([...(parsed.review?.rules ?? []), ...(parsed.reviewRules ?? [])])
      if (parsed.review?.modelRouting) config.review.modelRouting = sanitizeReviewModelRoutingConfig({ ...config.review.modelRouting, ...parsed.review.modelRouting })
      config.review.status.filesLoaded.push(relativePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      config.review.status.errors.push(`${relativePath}: ${(error as Error).message}`)
    }
  }
}

function mergeStringArray(config: CodeIntelligenceConfig, key: 'include' | 'exclude' | 'generatedPaths' | 'testPaths', value: unknown): void {
  if (Array.isArray(value)) config[key] = [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
}

function sanitizeEmbeddingConfig(value: CodeIntelligenceConfig['embedding']): CodeIntelligenceConfig['embedding'] {
  const rawBatchSizes = value.batchSizeByDevice && typeof value.batchSizeByDevice === 'object' ? value.batchSizeByDevice : {}
  const batchSizeByDevice = { ...DEFAULT_CONFIG.embedding.batchSizeByDevice }
  for (const device of ['cpu', 'gpu', 'webgpu', 'coreml', 'cuda', 'dml', 'auto'] as const) {
    batchSizeByDevice[device] = clampInteger(rawBatchSizes[device], 1, 512, batchSizeByDevice[device] ?? DEFAULT_CONFIG.embedding.batchSize)
  }
  return {
    ...value,
    batchSize: clampInteger(value.batchSize, 1, 512, DEFAULT_CONFIG.embedding.batchSize),
    batchSizeByDevice,
  }
}

function sanitizeIndexingConfig(value: CodeIntelligenceConfig['indexing']): CodeIntelligenceConfig['indexing'] {
  const fullRelationshipRefresh = value.fullRelationshipRefresh === 'all' || value.fullRelationshipRefresh === 'disabled' ? value.fullRelationshipRefresh : 'changed'
  return {
    scanConcurrency: clampInteger(value.scanConcurrency, 1, 16, DEFAULT_CONFIG.indexing.scanConcurrency),
    transactionBatchSize: clampInteger(value.transactionBatchSize, 1, 1000, DEFAULT_CONFIG.indexing.transactionBatchSize),
    progressIntervalMs: clampInteger(value.progressIntervalMs, 100, 10_000, DEFAULT_CONFIG.indexing.progressIntervalMs),
    progressFileInterval: clampInteger(value.progressFileInterval, 1, 10_000, DEFAULT_CONFIG.indexing.progressFileInterval),
    fullRelationshipRefresh,
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function sanitizeReviewModelRoutingConfig(value: ReviewModelRoutingConfig): ReviewModelRoutingConfig {
  const strategy = value.strategy === 'inherit' || value.strategy === 'explicit' ? value.strategy : 'same-family-cheap'
  const models: ReviewModelRoutingConfig['models'] = {}
  const rawModels = value.models && typeof value.models === 'object' ? value.models : {}
  for (const pass of ['default', 'triage', 'tests', 'aiSlop', 'correctness', 'security', 'verifier'] as const) {
    const model = rawModels[pass]
    if (typeof model === 'string' && model.trim().length > 0) models[pass] = model.trim()
  }
  return {
    strategy,
    allowCrossProvider: value.allowCrossProvider === true,
    models,
  }
}

function sanitizeReviewRules(rules: ReviewConfigRule[]): ReviewConfigRule[] {
  return rules
    .filter((rule) => rule && typeof rule.id === 'string' && typeof rule.instruction === 'string')
    .map((rule) => ({
      id: rule.id,
      severity: rule.severity === 'error' || rule.severity === 'warning' || rule.severity === 'info' ? rule.severity : 'warning',
      scope: Array.isArray(rule.scope) ? rule.scope.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : undefined,
      instruction: rule.instruction,
    }))
    .slice(0, 50)
}

async function loadGitignoreExcludePatterns(repoRoot: string): Promise<string[]> {
  try {
    const content = await readFile(join(repoRoot, '.gitignore'), 'utf8')
    return content
      .split(/\r?\n/)
      .map(parseGitignorePattern)
      .filter((pattern): pattern is string => Boolean(pattern))
  } catch {
    return []
  }
}

function parseGitignorePattern(line: string): string | undefined {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return undefined

  let pattern = trimmed.startsWith('\\#') ? trimmed.slice(1) : trimmed
  if (pattern.startsWith('/')) pattern = pattern.slice(1)
  if (pattern.endsWith('/')) pattern = `${pattern}**`
  return pattern || undefined
}

function cloneDefaultConfig(): CodeIntelligenceConfig {
  return {
    ...DEFAULT_CONFIG,
    include: [...DEFAULT_CONFIG.include],
    exclude: [...DEFAULT_CONFIG.exclude],
    packages: [...DEFAULT_CONFIG.packages],
    generatedPaths: [...DEFAULT_CONFIG.generatedPaths],
    testPaths: [...DEFAULT_CONFIG.testPaths],
    embedding: { ...DEFAULT_CONFIG.embedding, batchSizeByDevice: { ...DEFAULT_CONFIG.embedding.batchSizeByDevice } },
    indexing: { ...DEFAULT_CONFIG.indexing },
    review: {
      rules: [...DEFAULT_CONFIG.review.rules],
      status: { filesLoaded: [], errors: [] },
      modelRouting: {
        strategy: DEFAULT_CONFIG.review.modelRouting.strategy,
        allowCrossProvider: DEFAULT_CONFIG.review.modelRouting.allowCrossProvider,
        models: { ...DEFAULT_CONFIG.review.modelRouting.models },
      },
    },
  }
}
