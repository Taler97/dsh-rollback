/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-rollback`. It
 * validates the durable checkpoint manifest at the default store location:
 * every line is a well-formed {@link CheckpointRecord} whose kind/ref
 * relation holds (absent records carry no ref, blob/snapshot records carry a
 * string ref, blob records carry a repo root), and sequence numbers increase
 * strictly. A configured non-default `storeDir` is outside this check.
 *
 * @module @deepseek-ai/dsh-rollback/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST_FILE, lineToRecord } from './checkpoint.ts'

const PACKAGE_NAME = 'dsh-rollback'

/** Cordis companion plugin name. */
export const name = 'rollback-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate the durable manifest at the default store location, when present.
 * The manifest is append-only and written by the plugin's serial chain, so a
 * single read at install time covers the relation the store owns.
 */
const install: InvariantInstaller = async (_ctx: Context, fail: InvariantFailure) => {
  const manifestPath = join(dshHomePath('rollback'), MANIFEST_FILE)
  let text: string
  try {
    text = await fsp.readFile(manifestPath, 'utf8')
  } catch (error: unknown) {
    // A missing manifest is the normal cold start; other read failures are
    // reported through the plugin's own logger, not the invariant.
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return
    }
    fail(`cannot read manifest at ${manifestPath}: ${String(error)}`)
    return
  }
  let lastSeq = 0
  for (const line of text.split('\n')) {
    const record = lineToRecord(line)
    if (!record) {
      fail(`manifest line is not a well-formed checkpoint record: ${JSON.stringify(line.slice(0, 120))}`)
      continue
    }
    if (record.seq <= lastSeq) {
      fail(`manifest sequence ${record.seq} does not strictly follow ${lastSeq}`)
    }
    lastSeq = record.seq
  }
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
