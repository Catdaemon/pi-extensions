import { basename } from 'node:path'
import { minimatch } from 'minimatch'

const MATCH_OPTIONS = { dot: true, nocase: false }

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  const rel = normalizeRelativePath(path)
  const base = basename(rel)

  return patterns.some((pattern) => matchesGlob(rel, base, pattern))
}

export function matchesGlob(rel: string, base: string, rawPattern: string): boolean {
  const pattern = normalizeRelativePath(rawPattern.trim())
  if (!pattern) return false

  if (minimatch(rel, pattern, MATCH_OPTIONS)) return true
  if (minimatch(base, pattern, MATCH_OPTIONS)) return true

  if (!pattern.includes('/')) {
    if (rel.split('/').includes(pattern)) return true
    if (minimatch(rel, `**/${pattern}`, MATCH_OPTIONS)) return true
    if (minimatch(rel, `**/${pattern}/**`, MATCH_OPTIONS)) return true
  }

  if (minimatch(rel, `${pattern}/**`, MATCH_OPTIONS)) return true
  return false
}
