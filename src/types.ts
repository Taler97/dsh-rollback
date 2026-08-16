/**
 * Vocabulary for the rollback plugin: durable checkpoint records, the
 * checkpoint-backend union, and the minimal agent/session view used to scope a
 * restore without importing the agent or session packages.
 *
 * @module dsh-rollback/types
 */

/**
 * How one mutation's pre-image is retained. `absent` records a file that did
 * not exist before the mutation (restore deletes it); `blob` records the
 * pre-image in the workspace git object database (restore re-materializes it
 * with `git cat-file`); `snapshot` records the pre-image as a file copy under
 * the plugin's store directory.
 */
export type CheckpointKind = 'absent' | 'blob' | 'snapshot'

/**
 * One durable checkpoint record. `seq` increases monotonically across the
 * whole plugin lifetime (and across restarts via manifest replay), so a
 * restore by count is deterministic and stable.
 */
export interface CheckpointRecord {
  /** Monotonic sequence number, one per captured mutation. */
  readonly seq: number
  /**
   * Absolute path the restore writes to (or deletes for `absent`). Only local
   * absolute display paths from `dsh-tool-fs` write/edit outcomes are captured.
   */
  readonly path: string
  /** The pre-image retention kind. */
  readonly kind: CheckpointKind
  /**
   * Git blob object id for `blob`, or the snapshot file basename under the
   * store directory for `snapshot`; always absent for `absent`.
   */
  readonly ref?: string
  /** Git repository root for `blob` records (the `git -C` target). */
  readonly repoRoot?: string
  /** The tool name whose result produced this record (for diagnostics). */
  readonly tool: string
  /** Epoch-milliseconds capture time. */
  readonly time: number
}

/**
 * Minimal structural view of an agent used to scope a restore to the caller's
 * workspace. `@deepseek-ai/dsh-tools`' `ToolExecution.agent` and the command
 * handler's `Agent` both contain a `session`, so this plugin narrows either
 * without importing the agent or session packages.
 */
export interface RollbackAgentView {
  /** The agent's session, read only for its working directory. */
  session?: {
    /**
     * Creation metadata header. The session's working directory lives here
     * (`SessionHeader.cwd`), not on the session object itself.
     */
    header?: {
      /** Absolute working directory the session was created in, when any. */
      cwd?: string
    }
  }
}

/**
 * Result of one restore run: how many records were restored and the file
 * paths that changed, rendered into the command/tool confirmation text.
 */
export interface RestoreSummary {
  /** Number of checkpoint records restored. */
  readonly count: number
  /** Paths restored or deleted, in restore order (newest first). */
  readonly paths: readonly string[]
  /** Human-readable confirmation line. */
  readonly text: string
}
