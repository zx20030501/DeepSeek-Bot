import { appendFile, mkdir, readFile, rename, truncate, writeFile } from 'node:fs/promises'
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
  private appendReady = false

  public constructor(private readonly file: string) {}

  public async append(value: T): Promise<void> {
    this.writeTail = this.writeTail.then(async () => {
      await ensureDir(dirname(this.file))
      await this.prepareAppend()
      await appendFile(this.file, `${JSON.stringify(value)}\n`, 'utf8')
    })
    return this.writeTail
  }

  /**
   * Repair only a torn final record before the first append made by this
   * process. Journals are single-process writers; the in-memory write tail
   * serializes every later append. A complete JSON object that merely lost its
   * trailing newline is preserved, while an incomplete tail is truncated at
   * the last known-good line boundary.
   */
  private async prepareAppend(): Promise<void> {
    if (this.appendReady) return
    try {
      const raw = await readFile(this.file)
      if (raw.length === 0 || raw[raw.length - 1] === 0x0a) {
        this.appendReady = true
        return
      }
      const lastLineFeed = raw.lastIndexOf(0x0a)
      const tail = raw.subarray(lastLineFeed + 1).toString('utf8').trim()
      let completeObject = false
      if (tail.length > 0) {
        try {
          const value: unknown = JSON.parse(tail)
          completeObject = value !== null && typeof value === 'object'
        } catch {
          completeObject = false
        }
      }
      if (completeObject) {
        await appendFile(this.file, '\n', 'utf8')
      } else {
        await truncate(this.file, lastLineFeed + 1)
      }
      this.appendReady = true
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
      this.appendReady = true
    }
  }

  public async read(): Promise<T[]> {
    await this.writeTail
    try {
      const raw = await readFile(this.file, 'utf8')
      const rows: T[] = []
      const lines = raw.split(/\r?\n/u)
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const value: unknown = JSON.parse(trimmed)
          if (value !== null && typeof value === 'object') rows.push(value as T)
        } catch (error: unknown) {
          const tornFinalLine = index === lines.length - 1 && !raw.endsWith('\n')
          if (!tornFinalLine) {
            throw new Error(`Corrupt JSONL record at line ${index + 1} in ${this.file}`, { cause: error })
          }
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
      this.appendReady = true
    })
    return this.writeTail
  }
}

export function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
