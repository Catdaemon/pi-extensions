import { createHash } from 'node:crypto'

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}
