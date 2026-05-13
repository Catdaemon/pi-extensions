export function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n')
  if (normalized.length === 0) return []
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
