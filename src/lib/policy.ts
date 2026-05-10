import type { CcppConfig, ConfigSource, SyncPolicy } from './config.js';

/**
 * Resolve the active sync policy for a single source. Precedence (highest first):
 *
 *   1. CLI override        — `--prefer-latest` / `--pinned` for this run only.
 *   2. Per-source policy   — `sources[].policy` in `ccpp.config.json`.
 *   3. Global policy       — top-level `syncPolicy` in `ccpp.config.json`.
 *   4. Default             — `pinned` (the safe choice — no upstream surprises).
 *
 * Pure function. Lives here (not in `commands/sync.ts`) so the precedence
 * matrix can be unit-tested in isolation and reused by future commands
 * that need policy resolution (e.g. a planned `ccpp status --explain`).
 */
export function effectivePolicy(
  source: ConfigSource,
  config: CcppConfig,
  override: SyncPolicy | undefined,
): SyncPolicy {
  if (override !== undefined) return override;
  if (source.policy !== undefined) return source.policy;
  if (config.syncPolicy !== undefined) return config.syncPolicy;
  return 'pinned';
}

/**
 * Resolve whether the diff-preview prompt should be skipped for this run.
 * Precedence (highest first):
 *
 *   1. CLI flag            — `--auto-accept` for this run only.
 *   2. Config field        — `autoAccept: true` in `ccpp.config.json`.
 *   3. Default             — `false` (always prompt).
 *
 * The boolean meaning matches `autoAcceptEffective` in the sync flow:
 * `true` means apply silently; `false` means show the diff-preview and ask.
 */
export function effectiveAutoAccept(flag: boolean | undefined, config: CcppConfig): boolean {
  if (flag === true) return true;
  if (config.autoAccept === true) return true;
  return false;
}
