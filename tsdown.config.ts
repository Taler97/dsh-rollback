import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the standalone dsh-rollback bundle. It must not
 * assume any monorepo context: pnpm runs this `prepare` script right after a
 * `dsh plugin add github:user/dsh-rollback` git install, when only this
 * package's source (and its devDependencies) are present. Output lands in
 * `lib/` as plain ESM plus d.ts so `exports` resolves without a registry step.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
})
