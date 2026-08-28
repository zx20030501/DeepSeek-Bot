import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (value === 'localhost' || value === '::1') return true
  if (isIP(value) === 4) return value.startsWith('127.')
  return false
}

function isExternalHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return !isLoopbackHostname(url.hostname)
  } catch {
    return true
  }
}

/**
 * The setup API is intentionally local-only. Host/origin checks are combined
 * with the actual request socket address so a remotely reachable DSH listener
 * cannot be used with a forged Host header.
 *
 * Cursor/VS Code Simple Browser marks loopback fetches as `sec-fetch-site:
 * cross-site` and may send a `vscode-webview:` Origin. Those are still local
 * sockets. Classic CSRF (an external https Origin plus cross-site) is rejected.
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

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null' && isExternalHttpOrigin(origin)) {
    return false
  }
  return true
}
