import { splitLines } from '../../lib/text.ts'
import type { RawEntity } from './types.ts'

export function extractFallbackEntities(path: string, content: string, language?: string): RawEntity[] {
  const lines = splitLines(content)
  if (language === 'markdown' || path.endsWith('.md') || path.endsWith('.mdx')) {
    const headings = lines.flatMap((line, index) => {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      return match ? [{ name: match[2]!, kind: 'module', symbolKind: `h${match[1]!.length}`, startLine: index + 1, endLine: index + 1 }] : []
    })
    return headings.length > 0 ? headings : [{ name: path, qualifiedName: path, kind: 'module', symbolKind: 'module', startLine: 1, endLine: Math.max(1, lines.length) }]
  }
  if (['json', 'yaml', 'toml'].includes(language ?? '') || /\.(json|ya?ml|toml)$/.test(path)) return [{ name: path, qualifiedName: path, kind: 'module', symbolKind: 'config', startLine: 1, endLine: Math.max(1, lines.length) }]
  return []
}

