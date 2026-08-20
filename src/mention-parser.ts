import type {
  MentionParseMetadata,
  MentionParseResult,
  MentionParserOptions,
  MentionTarget,
  MentionTargetKind,
} from './fleet-v2-types.js'

const DEFAULT_MAX_TARGETS = 16
const DEFAULT_MAX_INPUT_LENGTH = 100_000
const DEFAULT_MAX_HOP = 8
const ID_PATTERN = /^[a-z0-9][a-z0-9_.:/-]{0,127}$/iu

interface TextRange {
  readonly start: number
  readonly end: number
}

interface Candidate {
  readonly target: MentionTarget
  readonly range: TextRange
}

export class MentionParserError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'MentionParserError'
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function normalizedSet(values: readonly string[] | undefined): Set<string> | undefined {
  return values === undefined ? undefined : new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))
}

function identity(kind: MentionTargetKind, id: string): string {
  return `${kind}:${id.toLowerCase()}`
}

function isInside(range: TextRange, position: number): boolean {
  return position >= range.start && position < range.end
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: TextRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) }
    } else merged.push(range)
  }
  return merged
}

/** Protect code, URLs, e-mail addresses and Markdown links from mention parsing. */
function protectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = []
  for (const expression of [
    /```[\s\S]*?```/gu,
    /`[^`\n]*`/gu,
    /\[[^\]\n]*\]\([^\)\n]*\)/gu,
    /\b(?:https?|ftp):\/\/[^\s<>()]+/giu,
    /\bwww\.[^\s<>()]+/giu,
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu,
  ]) {
    expression.lastIndex = 0
    for (const match of text.matchAll(expression)) {
      const start = match.index ?? 0
      ranges.push({ start, end: start + match[0].length })
    }
  }
  return mergeRanges(ranges)
}

function optionLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < 0 || selected > maximum) throw new MentionParserError('MENTION_OPTION_INVALID', `${label} must be an integer between 0 and ${maximum}`)
  return selected
}

function parseKind(rawId: string): { readonly kind: MentionTargetKind; readonly id: string } {
  const normalized = rawId.toLowerCase()
  if (normalized === 'team') return { kind: 'team', id: 'team' }
  if (normalized === 'manager') return { kind: 'manager', id: 'manager' }
  for (const prefix of ['team:', 'team/', 'manager:', 'manager/']) {
    if (!normalized.startsWith(prefix)) continue
    const kind = prefix.startsWith('team') ? 'team' : 'manager'
    const id = normalized.slice(prefix.length)
    return { kind, id: id || kind }
  }
  return { kind: 'bot', id: normalized }
}

function knownFor(
  kind: MentionTargetKind,
  id: string,
  bots: Set<string> | undefined,
  teams: Set<string> | undefined,
  managers: Set<string> | undefined,
): boolean {
  if (kind === 'bot') return bots === undefined || bots.has(id)
  if (kind === 'team') return teams === undefined || teams.has(id)
  return managers === undefined || managers.has(id)
}

function parseCandidate(
  match: RegExpMatchArray,
  text: string,
  ranges: readonly TextRange[],
  options: {
    readonly bots: Set<string> | undefined
    readonly teams: Set<string> | undefined
    readonly managers: Set<string> | undefined
    readonly selfId?: string
  },
): Candidate | undefined {
  const start = match.index ?? 0
  const end = start + match[0].length
  if (ranges.some(range => isInside(range, start))) return undefined
  const previous = start > 0 ? text[start - 1] : undefined
  if (previous !== undefined && /[\p{L}\p{N}_.%+\-]/u.test(previous)) return undefined
  const rawId = match[1]
  if (rawId === undefined || !ID_PATTERN.test(rawId)) return undefined
  const parsed = parseKind(rawId)
  if (!parsed.id || !ID_PATTERN.test(parsed.id)) return undefined
  const known = knownFor(parsed.kind, parsed.id, options.bots, options.teams, options.managers)
  const self = options.selfId !== undefined && parsed.id === options.selfId.trim().toLowerCase()
  return {
    target: {
      kind: parsed.kind,
      id: parsed.id,
      normalized: identity(parsed.kind, parsed.id),
      raw: match[0],
      start,
      end,
      known,
      self,
    },
    range: { start, end },
  }
}

function removeRanges(text: string, ranges: readonly TextRange[]): string {
  let result = text
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) result = result.slice(0, range.start) + result.slice(range.end)
  return result.replace(/[ \t]{2,}/gu, ' ').trim()
}

function visitedSet(values: readonly string[]): Set<string> {
  return new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))
}

/**
 * Pure mention parser. It returns syntax-level targets only; authorization and
 * routing remain the responsibility of Gateway/control-plane integration.
 */
export function parseFleetMentions(text: string, options: MentionParserOptions = {}): MentionParseResult {
  if (typeof text !== 'string') throw new MentionParserError('MENTION_INVALID_INPUT', 'Mention input must be text')
  const maxInputLength = optionLimit(options.maxInputLength, DEFAULT_MAX_INPUT_LENGTH, 1_000_000, 'maxInputLength')
  if (text.length > maxInputLength) throw new MentionParserError('MENTION_INPUT_TOO_LARGE', `Mention input exceeds ${maxInputLength} characters`)
  const maxTargets = optionLimit(options.maxTargets, DEFAULT_MAX_TARGETS, 500, 'maxTargets')
  const mentionBudget = optionLimit(options.mentionBudget, maxTargets, 500, 'mentionBudget')
  const hop = optionLimit(options.hop, 0, 128, 'hop')
  const maxHop = optionLimit(options.maxHop, DEFAULT_MAX_HOP, 128, 'maxHop')
  const visited = [...new Set((options.visited ?? []).map(value => value.trim().toLowerCase()).filter(Boolean))]
  const baseMetadata = { hop, visited, mentionBudget, remainingMentionBudget: mentionBudget, truncated: false } satisfies MentionParseMetadata
  if (hop > maxHop) {
    return {
      rawText: text,
      instruction: text.trim(),
      targets: [],
      routableTargets: [],
      unknownTargets: [],
      metadata: { ...baseMetadata, truncated: true, diagnostic: `hop ${hop} exceeds maxHop ${maxHop}` },
    }
  }
  if (mentionBudget === 0 || maxTargets === 0) {
    return {
      rawText: text,
      instruction: text.trim(),
      targets: [],
      routableTargets: [],
      unknownTargets: [],
      metadata: { ...baseMetadata, truncated: true, diagnostic: 'mention budget is exhausted' },
    }
  }
  const ranges = protectedRanges(text)
  const candidates: Candidate[] = []
  const allMentionRanges: TextRange[] = []
  const seen = new Set<string>()
  let limitReached = false
  const expression = /@([a-z0-9][a-z0-9_.:/-]{0,127})/giu
  for (const match of text.matchAll(expression)) {
    const candidate = parseCandidate(match, text, ranges, {
      bots: normalizedSet(options.knownBots),
      teams: normalizedSet(options.knownTeams),
      managers: normalizedSet(options.managerIds),
      ...(options.selfId === undefined ? {} : { selfId: options.selfId }),
    })
    if (candidate === undefined) continue
    allMentionRanges.push(candidate.range)
    const key = candidate.target.normalized
    if (seen.has(key)) continue
    if (candidates.length >= Math.min(maxTargets, mentionBudget)) {
      limitReached = true
      continue
    }
    seen.add(key)
    candidates.push(candidate)
  }
  const targets = candidates.map(item => item.target)
  const unknownTargets = targets.filter(target => !target.known)
  const visitedKeys = visitedSet(visited)
  const routableTargets = targets.filter(target => (
    target.known
    && !target.self
    && !visitedKeys.has(target.normalized)
    && !visitedKeys.has(target.id)
  ))
  const truncated = limitReached
  const metadata: MentionParseMetadata = {
    ...baseMetadata,
    remainingMentionBudget: Math.max(0, mentionBudget - targets.length),
    truncated,
    ...(truncated ? { diagnostic: 'mention target limit reached' } : {}),
  }
  return {
    rawText: text,
    instruction: removeRanges(text, allMentionRanges),
    targets: clone(targets),
    routableTargets: clone(routableTargets),
    unknownTargets: clone(unknownTargets),
    metadata,
  }
}

export const parseMentions = parseFleetMentions
