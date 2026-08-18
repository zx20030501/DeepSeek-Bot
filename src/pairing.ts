import { randomInt } from 'node:crypto'
import { JsonState } from './state.js'
import type { BotTarget, PairingApproval, PairingRequest } from './types.js'

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PAIRING_TTL_MS = 60 * 60 * 1_000
const NOTIFY_INTERVAL_MS = 10 * 60 * 1_000
const MAX_PENDING_PER_PLATFORM = 3

interface PairingFile {
  readonly version: 1
  readonly pending: Record<string, PairingRequest>
  readonly approved: Record<string, PairingApproval>
}

export interface PairingOffer {
  readonly request: PairingRequest
  readonly shouldNotify: boolean
}

function initialPairingFile(): PairingFile {
  return { version: 1, pending: {}, approved: {} }
}

function identityKey(platform: string, userId: string): string {
  return `${platform}:${userId}`
}

function generatePairingCode(): string {
  let code = ''
  for (let index = 0; index < 8; index += 1) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)] ?? ''
  }
  return code
}

function normalizedCode(value: string): string {
  return value.trim().toUpperCase()
}

/** Durable, local-only pairing requests and approvals. */
export class PairingStore {
  private readonly state: JsonState<PairingFile>

  public constructor(file: string) {
    this.state = new JsonState<PairingFile>(file, initialPairingFile())
  }

  public async load(): Promise<void> {
    await this.state.load()
  }

  public async request(target: BotTarget, now = Date.now()): Promise<PairingOffer | undefined> {
    if (target.userId === undefined || target.chatType !== 'dm') return undefined
    const userId = target.userId
    let result: PairingOffer | undefined
    await this.state.update(current => {
      for (const [key, request] of Object.entries(current.pending)) {
        if (request.expiresAt <= now) delete current.pending[key]
      }
      const key = identityKey(target.platform, userId)
      const existing = current.pending[key]
      if (existing !== undefined && existing.expiresAt > now) {
        const shouldNotify = now - existing.lastNotifiedAt >= NOTIFY_INTERVAL_MS
        const request = shouldNotify ? { ...existing, lastNotifiedAt: now } : existing
        current.pending[key] = request
        result = { request, shouldNotify }
        return current
      }
      const platformPending = Object.values(current.pending).filter(item => item.platform === target.platform)
      if (platformPending.length >= MAX_PENDING_PER_PLATFORM) return current
      const request: PairingRequest = {
        code: generatePairingCode(),
        platform: target.platform,
        userId,
        chatId: target.chatId,
        ...(target.chatType === undefined ? {} : { chatType: target.chatType }),
        createdAt: now,
        expiresAt: now + PAIRING_TTL_MS,
        lastNotifiedAt: now,
      }
      current.pending[key] = request
      result = { request, shouldNotify: true }
      return current
    })
    return result
  }

  public async approve(code: string, now = Date.now()): Promise<PairingRequest | undefined> {
    const wanted = normalizedCode(code)
    if (wanted === '') return undefined
    await this.state.load()
    let approved: PairingRequest | undefined
    await this.state.update(current => {
      const entry = Object.entries(current.pending).find(([, request]) => request.code === wanted)
      if (entry === undefined) return current
      const [key, request] = entry
      delete current.pending[key]
      if (request.expiresAt <= now) return current
      current.approved[identityKey(request.platform, request.userId)] = {
        platform: request.platform,
        userId: request.userId,
        approvedAt: now,
      }
      approved = request
      return current
    })
    return approved
  }

  public async isApproved(platform: string, userId: string): Promise<boolean> {
    await this.state.load()
    return this.state.snapshot().approved[identityKey(platform, userId)] !== undefined
  }

  public async revoke(platform: string, userId: string): Promise<boolean> {
    const key = identityKey(platform, userId)
    let removed = false
    await this.state.update(current => {
      if (current.approved[key] === undefined) return current
      delete current.approved[key]
      removed = true
      return current
    })
    return removed
  }

  public status(): { pending: PairingRequest[]; approved: PairingApproval[] } {
    const snapshot = this.state.snapshot()
    return {
      pending: Object.values(snapshot.pending).filter(request => request.expiresAt > Date.now()),
      approved: Object.values(snapshot.approved),
    }
  }
}
