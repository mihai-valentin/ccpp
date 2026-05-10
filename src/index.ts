/**
 * Public package entry — type re-exports only. The CLI lives in `src/cli.ts`
 * and ships as the `ccpp` bin; programmatic consumers should import types
 * from this entry and treat anything not exported here as internal.
 *
 * The list below is an explicit allowlist (not a star-export) so adding a
 * type to `lib/types.ts` does not silently leak it into the public surface.
 * Parser-internal shapes like `MarketplaceJson` and `PluginJson` are
 * intentionally absent.
 */
export type {
  Agent,
  Conflict,
  LockInstalledEntry,
  LockSourceEntry,
  Lockfile,
  Manifest,
  PluginManifest,
  ResolvedManifest,
  ResolvedSource,
  Skill,
  SlashCommand,
  Source,
} from './lib/types.js';
