import { extname } from 'node:path'
import { sha256Text } from './hash.ts'

export type CodeChunk = {
  chunkKind: string
  symbolName?: string
  symbolKind?: string
  startLine: number
  endLine: number
  content: string
  contentHash: string
}

type RawChunk = Omit<CodeChunk, 'contentHash'>

const DEFAULT_WINDOW_LINES = 120
const DEFAULT_OVERLAP_LINES = 20

export function chunkFile(input: { path: string; language?: string; content: string }): CodeChunk[] {
  const ext = extname(input.path).toLowerCase()
  const language = input.language

  let rawChunks: RawChunk[]
  if (language === 'markdown' || ext === '.md' || ext === '.mdx') {
    rawChunks = chunkMarkdown(input.content)
  } else if (
    language === 'typescript' ||
    language === 'typescriptreact' ||
    language === 'javascript' ||
    language === 'javascriptreact' ||
    ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)
  ) {
    rawChunks = chunkTypeScriptLike(input.content)
  } else if (['json', 'yaml', 'toml'].includes(language ?? '') || ['.json', '.yaml', '.yml', '.toml'].includes(ext)) {
    rawChunks = chunkConfig(input.content)
  } else {
    rawChunks = chunkLineWindows(input.content)
  }

  return rawChunks
    .filter((chunk) => chunk.content.trim().length > 0)
    .map((chunk) => ({ ...chunk, contentHash: sha256Text(chunk.content) }))
}

export function chunkMarkdown(content: string): RawChunk[] {
  const lines = splitLines(content)
  const headings: Array<{ lineIndex: number; title: string; level: number }> = []

  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (match) headings.push({ lineIndex: index, title: match[2] ?? '', level: match[1]?.length ?? 1 })
  })

  if (headings.length === 0) return chunkLineWindows(content, 'markdown_section')

  return headings.map((heading, index) => {
    const endExclusive = headings[index + 1]?.lineIndex ?? lines.length
    return {
      chunkKind: 'markdown_section',
      symbolName: heading.title,
      symbolKind: `h${heading.level}`,
      startLine: heading.lineIndex + 1,
      endLine: endExclusive,
      content: lines.slice(heading.lineIndex, endExclusive).join('\n'),
    }
  })
}

export function chunkConfig(content: string): RawChunk[] {
  const lines = splitLines(content)
  if (lines.length <= DEFAULT_WINDOW_LINES) {
    return [{ chunkKind: 'config', startLine: 1, endLine: Math.max(1, lines.length), content }]
  }
  return chunkLineWindows(content, 'config')
}

export function chunkTypeScriptLike(content: string): RawChunk[] {
  const lines = splitLines(content)
  const declarations = findTopLevelDeclarations(lines)

  if (declarations.length === 0) return chunkLineWindows(content, 'module')

  const chunks: RawChunk[] = []
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index]
    const nextStart = declarations[index + 1]?.startLine ?? lines.length + 1
    const leadingStart = findLeadingCommentStart(lines, declaration.startLine)
    const endLine = Math.max(declaration.startLine, nextStart - 1)
    chunks.push({
      chunkKind: declaration.chunkKind,
      symbolName: declaration.symbolName,
      symbolKind: declaration.symbolKind,
      startLine: leadingStart,
      endLine,
      content: lines.slice(leadingStart - 1, endLine).join('\n'),
    })
  }

  return splitOversizedChunks(chunks)
}

export function chunkLineWindows(content: string, chunkKind = 'module'): RawChunk[] {
  const lines = splitLines(content)
  if (lines.length === 0) return []

  const chunks: RawChunk[] = []
  let start = 0
  while (start < lines.length) {
    const end = Math.min(lines.length, start + DEFAULT_WINDOW_LINES)
    chunks.push({
      chunkKind,
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join('\n'),
    })
    if (end >= lines.length) break
    start = Math.max(end - DEFAULT_OVERLAP_LINES, start + 1)
  }
  return chunks
}

function splitOversizedChunks(chunks: RawChunk[]): RawChunk[] {
  return chunks.flatMap((chunk) => {
    const lineCount = chunk.endLine - chunk.startLine + 1
    if (lineCount <= DEFAULT_WINDOW_LINES * 1.5) return [chunk]
    return chunkLineWindows(chunk.content, chunk.chunkKind).map((part) => ({
      ...part,
      symbolName: chunk.symbolName,
      symbolKind: chunk.symbolKind,
      startLine: chunk.startLine + part.startLine - 1,
      endLine: chunk.startLine + part.endLine - 1,
    }))
  })
}

function findTopLevelDeclarations(lines: string[]) {
  const declarations: Array<{
    startLine: number
    chunkKind: string
    symbolName?: string
    symbolKind?: string
  }> = []

  let braceDepth = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    const depthBefore = braceDepth

    if (depthBefore === 0 || /^export\s+default\s+/.test(trimmed)) {
      const declaration = parseDeclaration(trimmed)
      if (declaration) declarations.push({ startLine: index + 1, ...declaration })
    }

    braceDepth = updateBraceDepth(line, braceDepth)
  }

  return declarations
}

function parseDeclaration(line: string): { chunkKind: string; symbolName?: string; symbolKind?: string } | undefined {
  const patterns: Array<[RegExp, string, string]> = [
    [/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function', 'function'],
    [/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class', 'class'],
    [/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface', 'interface'],
    [/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, 'type', 'type'],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*?\)?\s*=>/, 'function', 'function'],
    [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'module', 'constant'],
    [/^(?:export\s+)?describe\s*\(\s*(['"`])(.+?)\1/, 'test', 'describe'],
    [/^(?:export\s+)?(?:it|test)\s*\(\s*(['"`])(.+?)\1/, 'test', 'test'],
  ]

  for (const [pattern, chunkKind, symbolKind] of patterns) {
    const match = pattern.exec(line)
    if (!match) continue
    const symbolName = symbolKind === 'describe' || symbolKind === 'test' ? match[2] : match[1]
    return { chunkKind, symbolName: symbolName ?? symbolKind, symbolKind }
  }

  if (/^export\s+default\s+/.test(line)) return { chunkKind: 'module', symbolName: 'default export', symbolKind: 'export' }
  return undefined
}

function findLeadingCommentStart(lines: string[], declarationLine: number): number {
  let start = declarationLine
  for (let index = declarationLine - 2; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? '').trim()
    if (trimmed === '') {
      if (start === declarationLine) continue
      break
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.endsWith('*/')) {
      start = index + 1
      continue
    }
    break
  }
  return start
}

function updateBraceDepth(line: string, current: number): number {
  const withoutStrings = line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
  let next = current
  for (const char of withoutStrings) {
    if (char === '{') next += 1
    else if (char === '}') next = Math.max(0, next - 1)
  }
  return next
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n')
  if (normalized.length === 0) return []
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
