/**
 * File-mutation rollback plugin: it observes every successful tool result for
 * the pre-image a write/edit mutation reports, checkpoints that pre-image into
 * the workspace git object database or a snapshot store, and exposes restore
 * through a model-facing `rollback_files` tool and a `/rollback` human command.
 *
 * The plugin registers no service and changes no loop code. Capture rides the
 * `tools/result` observation event (the immutable final outcome), so it cannot
 * alter what the model sees; restore writes files directly (never through the
 * fs policy seam or the sandbox), because undoing a mutation must not be gated
 * by the very policy the mutation passed.
 *
 * @module dsh-rollback
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isAbsolute } from 'node:path'
import { CheckpointStore } from './checkpoint.ts'
import type { RestoreSummary, RollbackAgentView } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rollback'

/** The tool registry service this plugin reads for restore registration. */
export const inject = ['tools']

/**
 * Plugin configuration. `mode` picks the retention backend (`auto` uses git
 * per file when the workspace is a repository and snapshots otherwise), and
 * `storeDir` defaults to the rollback directory under the Harness home.
 * All keys are optional — `Config` supplies the defaults.
 */
export interface Config {
  /** `git` when the workspace is a repository, `snapshot` otherwise, `auto` picks per file. */
  mode?: 'auto' | 'git' | 'snapshot'
  /** Root holding the durable manifest and `snapshots/`; empty uses the Harness home. */
  storeDir?: string
  /** Upper bound on in-memory records per store. */
  maxRecords?: number
  /** Git executable name or absolute path. */
  gitPath?: string
}

export const Config: z<Config> = z.object({
  mode: z.union(['auto', 'git', 'snapshot']).default('auto'),
  storeDir: z.string().default(''),
  maxRecords: z.number().min(1).default(200),
  gitPath: z.string().default('git'),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/**
 * Convert the write/edit canonical value into a capture input, or `undefined`
 * when the result is not a file mutation this plugin can checkpoint. Only
 * absolute local paths are captured; relative or remote display paths are
 * ignored so a remote filesystem backend never leaks a restorable reference.
 */
function captureInputOf(
  result: ToolExecutionResult,
): { path: string; before: string | undefined } | undefined {
  if (result.isError) return undefined
  const value = result.value
  if (typeof value !== 'object' || value === null) return undefined
  const path = (value as Record<string, unknown>).path
  if (typeof path !== 'string' || !isAbsolute(path)) return undefined
  const before = (value as Record<string, unknown>).before
  if (before !== null && typeof before !== 'string') return undefined
  // A successful result without a `before` field is not a checkpointable
  // mutation (e.g. read/search tools return no pre-image).
  if (!('before' in value)) return undefined
  return { path, before: before === null ? undefined : before }
}

/**
 * The agent's session working directory, or `undefined` when the call has no
 * session (direct tool calls). The cwd lives on the session header
 * (`SessionHeader.cwd`); restores are scoped to it so a rollback never undoes
 * another session's work.
 */
function agentCwd(agent: unknown): string | undefined {
  const session = (agent as RollbackAgentView | undefined)?.session
  return typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
}

/** Parse the `/rollback` free-form input as a positive count (default 1). */
function parseCount(rawInput: string): number {
  const n = Number.parseInt(rawInput.trim(), 10)
  return Number.isSafeInteger(n) && n > 0 ? n : 1
}

/**
 * Register the capture listener, the `rollback_files` tool, and the
 * `/rollback` command, and start the store's manifest replay.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  const store = new CheckpointStore({
    mode: resolved.mode,
    storeDir: resolved.storeDir.length > 0 ? resolved.storeDir : dshHomePath('rollback'),
    maxRecords: resolved.maxRecords,
    gitPath: resolved.gitPath,
    onError: (message) => {
      ctx.logger.warn(message)
    },
  })
  store.start()

  // Capture: observe the immutable final outcome of every tool call. The
  // registry reports observer failures without aborting the tool pipeline, so
  // a slow checkpoint write never delays or corrupts the model-visible result.
  ctx.on('tools/result', (exec, result) => {
    const input = captureInputOf(result)
    if (!input) return
    void store.capture({ ...input, tool: exec.name }).catch((error: unknown) => {
      ctx.logger.warn(`rollback: capture failed for ${input.path}: ${String(error)}`)
    })
  })

  // Model-facing restore: undo the most recent N checkpointed mutations in the
  // calling agent's workspace.
  ctx.tools.register(defineTool({
    name: 'rollback_files',
    description: 'Restore the most recently checkpointed file mutations in the current workspace (undo write/edit operations).',
    parameters: {
      count: {
        type: 'integer',
        description: 'Number of most-recent file mutations to restore (default 1).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<string> {
      const cwd = agentCwd(exec.agent)
      if (cwd === undefined) return 'rollback: no session working directory to scope the restore'
      const summary: RestoreSummary = await store.restore(args.count ?? 1, cwd)
      return summary.text
    },
  }))

  // Human command: the same restore for the receiving agent's session. The
  // child activates only when a command registry is composed.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'rollback',
      description: 'Restore the most recently checkpointed file mutations',
      input: { hint: '[count]' },
      handler: async ({ agent, rawInput }) => {
        const cwd = agentCwd(agent)
        if (cwd === undefined) return { kind: 'error', text: 'rollback: no session working directory' }
        const summary = await store.restore(parseCount(rawInput), cwd)
        return { kind: 'success', text: summary.text }
      },
    })
  })
}
