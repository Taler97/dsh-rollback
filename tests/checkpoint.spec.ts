/** Store-level checkpoint tests: capture/restore for each kind, replay, and bounds. */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointStore } from '../src/checkpoint.ts'
import type { CheckpointConfig } from '../src/checkpoint.ts'

const errors: string[] = []

function storeDir(root: string): string {
  return join(root, 'rollback-store')
}

function config(root: string, overrides: Partial<CheckpointConfig> = {}): CheckpointConfig {
  return {
    mode: 'auto',
    storeDir: storeDir(root),
    maxRecords: 100,
    gitPath: 'git',
    onError: message => errors.push(message),
    ...overrides,
  }
}

async function gitInit(root: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['init', '--quiet', root], (error) => {
      if (error) reject(new Error(error.message))
      else resolve()
    })
  })
}

describe('CheckpointStore capture/restore', () => {
  let root: string

  beforeEach(async () => {
    root = await fsp.mkdtemp(join(tmpdir(), 'dsh-rollback-'))
    errors.length = 0
  })

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('captures an absent pre-image and restore deletes the file', async () => {
    const file = join(root, 'created.txt')
    await fsp.writeFile(file, 'new content')
    const store = new CheckpointStore(config(root))
    store.start()
    await store.capture({ path: file, before: undefined, tool: 'write' })
    expect(await store.restore(1)).toMatchObject({ count: 1, paths: [file] })
    await expect(fsp.access(file)).rejects.toThrow()
  })

  it('captures a snapshot pre-image (auto mode, no repository) and restore rewrites it', async () => {
    const file = join(root, 'a.txt')
    await fsp.writeFile(file, 'original')
    const store = new CheckpointStore(config(root))
    store.start()
    await store.capture({ path: file, before: 'original', tool: 'edit' })
    await fsp.writeFile(file, 'mutated')
    expect(await store.restore(1)).toMatchObject({ count: 1 })
    expect(await fsp.readFile(file, 'utf8')).toBe('original')
  })

  it('git mode stores a blob and restore re-materializes it', async () => {
    await gitInit(root)
    const file = join(root, 'a.txt')
    await fsp.writeFile(file, 'original')
    const store = new CheckpointStore(config(root, { mode: 'git' }))
    store.start()
    const record = await store.capture({ path: file, before: 'original', tool: 'write' })
    expect(record.kind).toBe('blob')
    expect(record.ref).toBeTruthy()
    await fsp.writeFile(file, 'mutated')
    await store.restore(1)
    expect(await fsp.readFile(file, 'utf8')).toBe('original')
  })

  it('auto mode uses git inside a repository and snapshots outside it', async () => {
    const repo = join(root, 'repo')
    const elsewhere = join(root, 'elsewhere')
    await fsp.mkdir(repo, { recursive: true })
    await fsp.mkdir(elsewhere, { recursive: true })
    await gitInit(repo)
    const inside = join(repo, 'inside.txt')
    const outside = join(elsewhere, 'outside.txt')
    await fsp.writeFile(inside, 'v1')
    await fsp.writeFile(outside, 'v1')
    const store = new CheckpointStore(config(root))
    store.start()
    expect((await store.capture({ path: inside, before: 'v1', tool: 'write' })).kind).toBe('blob')
    expect((await store.capture({ path: outside, before: 'v1', tool: 'write' })).kind).toBe('snapshot')
    await fsp.rm(outside)
    await store.restore(2)
    expect(await fsp.readFile(inside, 'utf8')).toBe('v1')
    expect(await fsp.readFile(outside, 'utf8')).toBe('v1')
  })

  it('git mode fails loud outside a repository and records nothing', async () => {
    const file = join(root, 'a.txt')
    await fsp.writeFile(file, 'v1')
    const store = new CheckpointStore(config(root, { mode: 'git' }))
    store.start()
    await expect(store.capture({ path: file, before: 'v1', tool: 'write' })).rejects.toThrow(/no repository/)
    expect(await store.restore(1)).toMatchObject({ count: 0 })
  })

  it('replay after a restart restores the same records (durable manifest)', async () => {
    const file = join(root, 'a.txt')
    await fsp.writeFile(file, 'original')
    const first = new CheckpointStore(config(root))
    first.start()
    await first.capture({ path: file, before: 'original', tool: 'write' })
    await fsp.writeFile(file, 'mutated')
    const second = new CheckpointStore(config(root))
    second.start()
    expect(await second.restore(1)).toMatchObject({ count: 1 })
    expect(await fsp.readFile(file, 'utf8')).toBe('original')
  })

  it('restore scopes to the `under` directory', async () => {
    const inWorkspace = join(root, 'ws', 'a.txt')
    const outOfWorkspace = join(root, 'elsewhere', 'b.txt')
    await fsp.mkdir(join(root, 'ws'), { recursive: true })
    await fsp.mkdir(join(root, 'elsewhere'), { recursive: true })
    await fsp.writeFile(inWorkspace, 'v1')
    await fsp.writeFile(outOfWorkspace, 'v1')
    const store = new CheckpointStore(config(root))
    store.start()
    await store.capture({ path: inWorkspace, before: 'v1', tool: 'write' })
    await store.capture({ path: outOfWorkspace, before: 'v1', tool: 'write' })
    await fsp.writeFile(inWorkspace, 'mutated')
    await fsp.writeFile(outOfWorkspace, 'mutated')
    expect(await store.restore(1, join(root, 'ws'))).toMatchObject({ count: 1, paths: [inWorkspace] })
    expect(await fsp.readFile(inWorkspace, 'utf8')).toBe('v1')
    expect(await fsp.readFile(outOfWorkspace, 'utf8')).toBe('mutated')
  })

  it('bounded records drop the oldest beyond maxRecords', async () => {
    const store = new CheckpointStore(config(root, { maxRecords: 2 }))
    store.start()
    for (let i = 0; i < 4; i++) {
      await store.capture({ path: join(root, `${i}.txt`), before: `${i}`, tool: 'write' })
    }
    const summary = await store.restore(2)
    expect(summary.count).toBe(2)
    expect(summary.paths).toEqual([join(root, '2.txt'), join(root, '3.txt')])
  })

  it('replayed records stay restorable after a restore (idempotent across restarts)', async () => {
    const file = join(root, 'a.txt')
    await fsp.writeFile(file, 'original')
    const first = new CheckpointStore(config(root))
    first.start()
    await first.capture({ path: file, before: 'original', tool: 'write' })
    await fsp.writeFile(file, 'mutated')
    await first.restore(1)
    expect(await fsp.readFile(file, 'utf8')).toBe('original')
    // The manifest is append-only: a restart replays the same record, so a
    // later restore re-applies the identical pre-image (no double-undo).
    await fsp.writeFile(file, 'mutated again')
    const second = new CheckpointStore(config(root))
    second.start()
    expect(await second.restore(1)).toMatchObject({ count: 1 })
    expect(await fsp.readFile(file, 'utf8')).toBe('original')
  })

  it('restore summary lists every restored path with its action', async () => {
    const edited = join(root, 'a.txt')
    await fsp.writeFile(edited, 'v1')
    const created = join(root, 'created.txt')
    await fsp.writeFile(created, 'new')
    const store = new CheckpointStore(config(root))
    store.start()
    await store.capture({ path: edited, before: 'v1', tool: 'edit' })
    await store.capture({ path: created, before: undefined, tool: 'write' })
    await fsp.writeFile(edited, 'mutated')
    const summary = await store.restore(2)
    expect(summary.count).toBe(2)
    expect(summary.text).toContain('restored 2 file mutation(s)')
    expect(summary.text).toContain(`restored  ${edited}`)
    expect(summary.text).toContain(`deleted  ${created}`)
  })
})
