import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (value === 'localhost' || value === '::1') return true
  if (isIP(value) === 4) return value.startsWith('127.')
  return false
}

/**
 * The setup API is intentionally local-only. Host/origin checks are combined
 * with the actual request socket address so a remotely reachable DSH listener
 * cannot be used with a forged Host header.
 */
export function isTrustedLocalRequest(req: IncomingMessage): boolean {
  const authority = req.headers.host
  if (typeof authority !== 'string' || authority.length === 0) return false
  let host: URL
  try {
    host = new URL(`http://${authority}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(host.hostname)) return false

  const remoteAddress = req.socket?.remoteAddress
  if (remoteAddress !== undefined) {
    const normalizedRemote = remoteAddress.replace(/^::ffff:/u, '')
    if (!isLoopbackHostname(normalizedRemote)) return false
  }

  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site') return false

  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return origin !== 'null' && new URL(origin).host === host.host
  } catch {
    return false
  }
}
