/**
 * Durable checkpoint store for the rollback plugin. It captures the pre-image
 * of a file mutation (the `before` content a write/edit tool reports) either as
 * a git blob in the workspace repository or as a snapshot file under the store
 * directory, appends one JSONL record to a durable manifest, and replays that
 * manifest on startup so restores survive restarts.
 *
 * All mutations run through one serial chain so capture and restore never
 * interleave. Git is spawned directly (never through a shell or the sandbox):
 * a restore is a deliberate system-level undo and must not be confined by the
 * sandbox it is undoing.
 *
 * @module dsh-rollback/src/checkpoint
 */

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CheckpointRecord, RestoreSummary } from './types.ts'

/** Plugin configuration resolved by the owning apply(). */
export interface CheckpointConfig {
  /** `git` when the workspace is a repository, `snapshot` otherwise, `auto` picks per file. */
  readonly mode: 'auto' | 'git' | 'snapshot'
  /** Root directory holding `manifest.jsonl` and the `snapshots/` subdirectory. */
  readonly storeDir: string
  /** Upper bound on in-memory records; the oldest are dropped beyond it. */
  readonly maxRecords: number
  /** Git executable name or absolute path. */
  readonly gitPath: string
  /** Error sink; the plugin wires this to `ctx.logger.warn`. */
  readonly onError: (message: string) => void
}

/** One captured pre-image, before the store decides its retention kind. */
export interface CaptureInput {
  /** Absolute path the mutation affected. */
  readonly path: string
  /** Pre-mutation content; `undefined` when the file did not exist. */
  readonly before: string | undefined
  /** Tool name that produced the mutation, for diagnostics. */
  readonly tool: string
}

/** Configuration and store name reported to the invariant companion. */
export const MANIFEST_FILE = 'manifest.jsonl'
/** Snapshot subdirectory name under the store directory. */
export const SNAPSHOT_DIR = 'snapshots'

/**
 * Write a file atomically (temp file + rename), creating parent directories.
 * @param target - absolute path to write.
 * @param content - full text content to persist.
 * @returns a promise settling after the atomic replace completes.
 */
async function writeFileAtomic(target: string, content: string): Promise<void> {
  await fsp.mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.rollback-${randomBytes(6).toString('hex')}`
  await fsp.writeFile(tmp, content)
  await fsp.rename(tmp, target)
}

/**
 * Serialize one record to its JSONL manifest line.
 * @param record - the checkpoint record to encode.
 * @returns one JSONL line without a trailing newline.
 */
export function recordToLine(record: CheckpointRecord): string {
  return JSON.stringify(record)
}

/**
 * Parse one JSONL manifest line; `null` when the line is not a valid record.
 * @param line - one raw manifest line.
 * @returns the decoded record, or `null` when the line is blank or malformed.
 */
export function lineToRecord(line: string): CheckpointRecord | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    const value: unknown = JSON.parse(trimmed)
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (typeof record.seq !== 'number' || typeof record.path !== 'string' || typeof record.kind !== 'string') return null
    const kind = record.kind
    if (kind !== 'absent' && kind !== 'blob' && kind !== 'snapshot') return null
    if (kind === 'absent' ? record.ref !== undefined : typeof record.ref !== 'string') return null
    if (kind === 'blob' && typeof record.repoRoot !== 'string') return null
    if (typeof record.tool !== 'string' || typeof record.time !== 'number') return null
    if (!isAbsolute(record.path)) return null
    return record as unknown as CheckpointRecord
  } catch {
    return null
  }
}

/**
 * The durable checkpoint store. One instance is created per `apply()`; disposal
 * is a no-op for the store itself because manifest and snapshots are files.
 */
export class CheckpointStore {
  /** Serial chain over every capture and restore, preserving order. */
  private chain: Promise<unknown> = Promise.resolve()
  /** In-memory record list, newest last, bounded by {@link CheckpointConfig.maxRecords}. */
  private records: CheckpointRecord[] = []
  /** Cached git repository root per directory (git mode detection). */
  private repoCache = new Map<string, string | undefined>()
  /** Next sequence number; starts past the replayed manifest tail. */
  private seq = 0

  /**
   * Construct the store; the durable manifest is replayed by {@link start}.
   * @param config - resolved plugin configuration.
   */
  constructor(private readonly config: CheckpointConfig) {}

  /** Durable manifest file path. */
  get manifestPath(): string {
    return join(this.config.storeDir, MANIFEST_FILE)
  }

  /**
   * Snapshot file path for one snapshot record.
   * @param ref - the snapshot record's `ref` basename.
   * @returns the absolute snapshot content path under the store directory.
   */
  snapshotPath(ref: string): string {
    return join(this.config.storeDir, SNAPSHOT_DIR, ref)
  }

  /**
   * Replay the durable manifest into the in-memory list so restores survive
   * restarts. Runs on the serial chain before any capture or restore, so a
   * reloaded plugin never observes a partial replay.
   * @returns nothing; the replay is scheduled on the serial chain.
   */
  start(): void {
    this.chain = this.chain.then(() => this.replay())
  }

  private async replay(): Promise<void> {
    this.seq = 0
    try {
      const text = await fsp.readFile(this.manifestPath, 'utf8')
      for (const line of text.split('\n')) {
        const record = lineToRecord(line)
        if (!record) continue
        this.records.push(record)
        this.seq = Math.max(this.seq, record.seq)
      }
    } catch (error: unknown) {
      // A missing manifest is the normal cold start; anything else is read-only
      // and reported so the operator can inspect the store.
      if (isNodeError(error) && error.code !== 'ENOENT') {
        this.config.onError(`rollback: manifest replay failed: ${String(error)}`)
      }
    }
    this.trim()
  }

  /**
   * Capture one mutation pre-image. The record is appended to the in-memory
   * list and the durable manifest; the git blob or snapshot write runs on the
   * serial chain so `restore()` always observes a completed capture.
   * @param input - the mutation pre-image to checkpoint.
   * @returns the durable record that was appended.
   */
  capture(input: CaptureInput): Promise<CheckpointRecord> {
    const task = this.chain.then(() => this.doCapture(input))
    this.chain = task.catch(() => undefined)
    return task
  }

  private async doCapture(input: CaptureInput): Promise<CheckpointRecord> {
    const seq = ++this.seq
    const record = await this.buildRecord(seq, input)
    this.records.push(record)
    this.trim()
    try {
      await fsp.mkdir(this.config.storeDir, { recursive: true })
      await fsp.appendFile(this.manifestPath, `${recordToLine(record)}\n`, 'utf8')
    } catch (error: unknown) {
      this.config.onError(`rollback: manifest append failed for seq ${seq}: ${String(error)}`)
    }
    return record
  }

  private async buildRecord(seq: number, input: CaptureInput): Promise<CheckpointRecord> {
    const base: Omit<CheckpointRecord, 'kind' | 'ref' | 'repoRoot'> = {
      seq,
      path: input.path,
      tool: input.tool,
      time: Date.now(),
    }
    if (input.before === undefined) {
      return { ...base, kind: 'absent' }
    }
    const repoRoot = await this.findRepoRoot(dirname(input.path))
    if (this.config.mode === 'snapshot' || (this.config.mode === 'auto' && repoRoot === undefined)) {
      const ref = `${seq}.content`
      await writeFileAtomic(this.snapshotPath(ref), input.before)
      return { ...base, kind: 'snapshot', ref }
    }
    if (repoRoot === undefined) {
      // mode 'git' with no repository: fail loud, keep the mutation unlogged.
      throw new Error(`rollback: git mode has no repository above "${input.path}"`)
    }
    const hash = await this.git(repoRoot, ['hash-object', '-w', '--stdin'], input.before)
    return { ...base, kind: 'blob', ref: hash.trim(), repoRoot }
  }

  /**
   * Restore the most recent `count` records whose path lies at or under `under`
   * (when given), newest first. Restored records are removed from the in-memory
   * list; the durable manifest stays append-only, so a replay after a restart
   * re-exposes the same records (restore remains idempotent).
   * @param count - number of most-recent matching records to restore.
   * @param under - optional directory that restricts which records qualify.
   * @returns a summary of the restored records.
   */
  restore(count: number, under?: string): Promise<RestoreSummary> {
    const task = this.chain.then(() => this.doRestore(count, under))
    this.chain = task.catch(() => undefined)
    return task
  }

  private async doRestore(count: number, under: string | undefined): Promise<RestoreSummary> {
    const candidates = this.records.filter(record => under === undefined || this.contains(under, record.path))
    const selected = candidates.slice(-count)
    const paths: string[] = []
    for (const record of selected) {
      await this.applyRestore(record)
      paths.push(record.path)
    }
    if (selected.length > 0) {
      const last = selected.at(-1)
      if (last) {
        const lastSeq = last.seq
        this.records = this.records.filter(record => record.seq > lastSeq || !selected.includes(record))
      }
    }
    const text = selected.length === 0
      ? 'rollback: nothing to restore'
      : [
          `rollback: restored ${selected.length} file mutation(s):`,
          ...selected.map(record => `  ${record.kind === 'absent' ? 'deleted' : 'restored'}  ${record.path}`),
        ].join('\n')
    return { count: selected.length, paths, text }
  }

  private async applyRestore(record: CheckpointRecord): Promise<void> {
    if (record.kind === 'absent') {
      try {
        await fsp.unlink(record.path)
      } catch (error: unknown) {
        if (!isNodeError(error) || error.code !== 'ENOENT') throw error
      }
      return
    }
    let content: string
    if (record.kind === 'blob' && record.repoRoot && record.ref) {
      content = await this.git(record.repoRoot, ['cat-file', 'blob', record.ref])
    } else if (record.kind === 'snapshot' && record.ref) {
      content = await fsp.readFile(this.snapshotPath(record.ref), 'utf8')
    } else {
      throw new Error(`rollback: malformed record seq ${record.seq}`)
    }
    await writeFileAtomic(record.path, content)
  }

  /** True when `path` equals `root` or lies beneath it (separator-agnostic). */
  private contains(root: string, path: string): boolean {
    const rel = relative(root, path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  /** Drop the oldest records beyond {@link CheckpointConfig.maxRecords}. */
  private trim(): void {
    if (this.records.length > this.config.maxRecords) {
      this.records = this.records.slice(-this.config.maxRecords)
    }
  }

  /**
   * Walk up from a directory to the nearest git repository root (a `.git`
   * entry), caching the result per directory. Returns `undefined` outside a
   * repository.
   */
  private async findRepoRoot(start: string): Promise<string | undefined> {
    let dir = start
    const visited: string[] = []
    while (true) {
      const cached = this.repoCache.get(dir)
      if (cached !== undefined || this.repoCache.has(dir)) return cached
      visited.push(dir)
      try {
        await fsp.access(join(dir, '.git'))
        const root = dir
        for (const d of visited) this.repoCache.set(d, root)
        return root
      } catch {
        // fall through to the parent
      }
      const parent = parentDir(dir)
      if (parent === dir) {
        for (const d of visited) this.repoCache.set(d, undefined)
        return undefined
      }
      dir = parent
    }
  }

  /** Run one git command in a repository and return stdout. */
  private git(repoRoot: string, args: readonly string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.gitPath, ['-C', repoRoot, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (task: () => void): void => {
        if (!settled) {
          settled = true
          task()
        }
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', (error: Error) => {
        finish(() => {
          reject(new Error(`rollback: git ${args[0]} failed: ${error.message}`))
        })
      })
      child.on('close', (code: number | null) => {
        finish(() => {
          if (code === 0) {
            resolve(stdout)
          } else {
            reject(new Error(`rollback: git ${args[0]} failed with exit ${code}: ${stderr.trim()}`))
          }
        })
      })
      if (input !== undefined) child.stdin.write(input)
      child.stdin.end()
    })
  }
}

/** Structural narrowing for Node error codes. */
function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === 'object' && value !== null && 'code' in value
}

/** Parent directory of a path, returning the path itself at a filesystem root. */
function parentDir(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(part => part.length > 0)
  if (parts.length <= 1) return dir
  return parts.slice(0, -1).join(dir.startsWith('\\') ? '\\' : '/') || (dir.startsWith('/') ? '/' : '')
}
