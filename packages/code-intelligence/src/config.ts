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
    maxConcurrentBatches: number
    pauseWhenOnBattery: boolean
    lowPriority: boolean
    modelCacheDir: string
    device: 'auto' | 'cpu' | 'gpu' | 'webgpu' | 'coreml' | 'cuda' | 'dml'
    dtype: 'auto' | 'fp32' | 'fp16' | 'q8' | 'q4'
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
    model: 'jinaai/jina-embeddings-v2-base-code',
    fallbackModel: 'onnx-community/granite-embedding-small-english-r2-ONNX',
    emergencyFallbackModel: 'Xenova/all-MiniLM-L6-v2',
    autoDownload: true,
    batchSize: 8,
    maxConcurrentBatches: 1,
    pauseWhenOnBattery: false,
    lowPriority: true,
    modelCacheDir: '$XDG_DATA_HOME/pi-code-intelligence/models',
    device: 'cpu',
    dtype: 'auto',
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
      if (parsed.review?.rules || parsed.reviewRules) config.review.rules = sanitizeReviewRules([...(parsed.review?.rules ?? []), ...(parsed.reviewRules ?? [])])
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
    embedding: { ...DEFAULT_CONFIG.embedding },
    review: { rules: [...DEFAULT_CONFIG.review.rules], status: { filesLoaded: [], errors: [] } },
  }
}
