import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

/**
 * A tiny append-only JSONL journal. A serialized write tail prevents two
 * inbound updates from interleaving their lines when the transport is busy.
 */
export class JsonlJournal<T extends object> {
  private writeTail: Promise<void> = Promise.resolve()

  public constructor(private readonly file: string) {}

  public async append(value: T): Promise<void> {
    this.writeTail = this.writeTail.then(async () => {
      await ensureDir(dirname(this.file))
      await appendFile(this.file, `${JSON.stringify(value)}\n`, 'utf8')
    })
    return this.writeTail
  }

  public async read(): Promise<T[]> {
    await this.writeTail
    try {
      const raw = await readFile(this.file, 'utf8')
      const rows: T[] = []
      for (const line of raw.split(/\r?\n/u)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const value: unknown = JSON.parse(trimmed)
          if (value !== null && typeof value === 'object') rows.push(value as T)
        } catch {
          // A torn final line is ignored. The next append remains valid JSONL.
        }
      }
      return rows
    } catch (error: unknown) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  public async replace(values: readonly T[]): Promise<void> {
    this.writeTail = this.writeTail.then(async () => {
      await ensureDir(dirname(this.file))
      const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`
      const content = values.length === 0
        ? ''
        : `${values.map(value => JSON.stringify(value)).join('\n')}\n`
      await writeFile(temporary, content, 'utf8')
      await rename(temporary, this.file)
    })
    return this.writeTail
  }
}

export function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
