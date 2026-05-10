const SCP_LIKE_REMOTE = /^(?:([^@/:]+)@)?([^:]+):(.+)$/

export function normalizeRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return ''

  const scpLike = trimmed.match(SCP_LIKE_REMOTE)
  if (scpLike && !trimmed.includes('://')) {
    return normalizeHostAndPath(scpLike[2] ?? '', scpLike[3] ?? '')
  }

  try {
    const url = new URL(trimmed)
    return normalizeHostAndPath(url.hostname, url.pathname)
  } catch {
    return normalizeHostAndPath('', trimmed)
  }
}

function normalizeHostAndPath(host: string, rawPath: string): string {
  const normalizedHost = host.trim().toLowerCase()
  let path = rawPath.trim().replace(/\\/g, '/')

  path = path.replace(/^\/+/, '').replace(/\/+$/, '')
  path = path.replace(/\.git$/i, '')
  path = path.replace(/\/+$/, '')

  const value = normalizedHost ? `${normalizedHost}/${path}` : path
  return value.replace(/\/+/, '/').toLowerCase()
}
