const CREDENTIAL_PATTERNS = [
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{16,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bauthorization\s*["']?\s*[:=]\s*["']?(?:bearer|basic)\s+[a-z0-9._~+/-]{12,}={0,2}/iu,
  /\bbearer\s+[a-z0-9._~+/-]{20,}={0,2}/iu,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/iu,
  /(?:[?&#;]|\\u0026)(?:access_?token|auth(?:orization)?_?token|api_?key|apikey|token|secret|credential|credentials|password|passwd|key|client_?secret|refresh_?token|private_?token|signature)\s*=\s*[^&#\s"']{8,}/iu,
  /\bgh[pousr]_[a-z0-9]{20,}\b/iu,
  /\bgithub_pat_[a-z0-9_]{20,}\b/iu,
  /\bglpat-[a-z0-9_-]{20,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[a-z0-9_-]{30,}\b/iu,
  /\bxox[baprs]-[a-z0-9-]{16,}\b/iu,
  /\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@/iu,
  /\b(?:api[_ -]?key|app[_ -]?secret|client[_ -]?secret|access[_ -]?token|auth(?:orization)?[_ -]?token|refresh[_ -]?token|private[_ -]?token|token|secret|credential|credentials|password|passwd|signature)\b\s*["']?\s*[:=]\s*["']?[a-z0-9_./+~-]{8,}/iu,
]

const SENSITIVE_URL_PARAMETER_KEYS = new Set([
  'accesstoken',
  'accesskey',
  'accesskeyid',
  'apikey',
  'appsecret',
  'authtoken',
  'authorization',
  'authorizationtoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentials',
  'key',
  'idtoken',
  'password',
  'passwd',
  'privatetoken',
  'refreshtoken',
  'sessiontoken',
  'secret',
  'secretkey',
  'sharedaccesssignature',
  'sig',
  'signature',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
])

function normalizedParameterKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, '').toLowerCase()
}

function parametersContainCredentials(parameters: URLSearchParams): boolean {
  for (const [key, value] of parameters) {
    if (value !== '' && SENSITIVE_URL_PARAMETER_KEYS.has(normalizedParameterKey(key))) return true
  }
  return false
}

function containsCredentialBearingUrl(value: string): boolean {
  const candidates = value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu) ?? []
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate)
      if (parsed.username !== '' || parsed.password !== '') return true
      if (parametersContainCredentials(parsed.searchParams)) return true
      const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
      if (fragment.includes('=') && parametersContainCredentials(new URLSearchParams(fragment))) return true
    } catch {
      // The regex scanner below remains the fail-safe for malformed URL text.
    }
  }
  return false
}

function decodedVariants(raw: string): string[] {
  const variants = new Set([raw])
  let decoded = raw
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      decoded = decodeURIComponent(decoded)
      variants.add(decoded)
    } catch {
      break
    }
  }
  return [...variants]
}

/**
 * Best-effort credential scan shared by every Fleet definition store.
 * Structured provider credentials belong in the DSH CredentialProvider and
 * must never be copied into user-authored Bot, Team, thread, or artifact text.
 */
export function containsCredentialMaterial(value: unknown): boolean {
  const strings: string[] = []
  const visited = new WeakSet<object>()
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      strings.push(candidate)
      return
    }
    if (candidate === null || typeof candidate !== 'object') return
    if (visited.has(candidate)) return
    visited.add(candidate)
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      return
    }
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      visit(item)
      if (typeof item === 'string' || typeof item === 'number') strings.push(`${key}=${String(item)}`)
    }
  }
  visit(value)
  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) strings.push(serialized)
  } catch {
    // The actual stores reject/normalize cyclic input separately. Scanning all
    // reachable strings above still keeps this helper fail-safe for that case.
  }
  return strings.some(raw => decodedVariants(raw).some(candidate => (
    containsCredentialBearingUrl(candidate)
    || CREDENTIAL_PATTERNS.some(pattern => pattern.test(candidate))
  )))
}

export function assertNoCredentialMaterial(value: unknown, message: string): void {
  if (containsCredentialMaterial(value)) throw new Error(message)
}
