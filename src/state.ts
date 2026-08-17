import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureDir, isNotFound } from './jsonl.js'

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Atomic JSON snapshot for routing state and small user preferences. */
export class JsonState<T extends object> {
  private value: T
  private loaded = false
  private tail: Promise<void> = Promise.resolve()

  public constructor(
    private readonly file: string,
    private readonly initial: T,
  ) {
    this.value = clone(initial)
  }

  public async load(): Promise<T> {
    if (this.loaded) return clone(this.value)
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        this.value = { ...clone(this.initial), ...(parsed as Partial<T>) }
      }
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
    this.loaded = true
    return clone(this.value)
  }

  public snapshot(): T {
    return clone(this.value)
  }

  public async update(mutator: (current: T) => T | void): Promise<T> {
    await this.load()
    let next: T = this.value
    this.tail = this.tail.then(async () => {
      const candidate = clone(this.value)
      const result = mutator(candidate)
      next = clone(result === undefined ? candidate : result)
      this.value = next
      await ensureDir(dirname(this.file))
      const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`
      await writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8')
      await rename(temporary, this.file)
    })
    await this.tail
    return clone(next)
  }
}
