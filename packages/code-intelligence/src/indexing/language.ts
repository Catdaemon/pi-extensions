import { extname } from 'node:path'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
}

export function detectLanguage(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]
}

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.xz',
  '.7z',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wasm',
  '.dylib',
  '.so',
  '.dll',
  '.exe',
])

export function isLikelyBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase())
}

export function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096)
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}
