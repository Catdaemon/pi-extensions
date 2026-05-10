import type { CodeIntelligenceConfig } from '../config.ts'
import { normalizeRelativePath } from '../indexing/glob.ts'

export function packageKeyForPath(relativePath: string, config: Pick<CodeIntelligenceConfig, 'packages'>): string | undefined {
  const rel = normalizeRelativePath(relativePath)
  const matches = config.packages
    .map((pkg) => ({ ...pkg, normalizedPath: normalizeRelativePath(pkg.path).replace(/\/$/, '') }))
    .filter((pkg) => rel === pkg.normalizedPath || rel.startsWith(`${pkg.normalizedPath}/`))
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)

  return matches[0]?.key
}
