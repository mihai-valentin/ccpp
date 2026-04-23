import {
  CONFIG_FILENAME,
  type CcppConfig,
  type ConfigSource,
  readConfig,
  type SyncPolicy,
} from '../lib/config.js';
import { cloneOrUpdate } from '../lib/git.js';
import { applyManifest } from '../lib/installer.js';
import { readLockfile, writeLockfile } from '../lib/lockfile.js';
import { parseManifest } from '../lib/manifest.js';
import { dim, green, yellow } from '../lib/term.js';
import type { Conflict } from '../lib/types.js';

// Private error classes — the cli.ts classifier reads `.exitCode` by duck-typing.
class UserError extends Error {
  readonly exitCode = 1;
}
class EnvError extends Error {
  readonly exitCode = 2;
}
class CollisionError extends Error {
  readonly exitCode = 3;
  readonly conflicts: Conflict[];
  constructor(message: string, conflicts: Conflict[]) {
    super(message);
    this.conflicts = conflicts;
  }
}

export type SyncOverride = SyncPolicy;

export interface SyncOverrideFlags {
  preferLatest?: boolean;
  pinned?: boolean;
  update?: boolean;
}

export interface RunSyncOpts {
  configPath: string;
  lockfilePath: string;
  claudeHome: string;
  json: boolean;
  quiet: boolean;
  override?: SyncOverride;
}

export interface SourceSyncReport {
  url: string;
  policy: SyncPolicy;
  priorSha: string | null;
  sha: string;
  ref: string;
  installed: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  conflicts: Conflict[];
  backups: string[];
}

export interface SyncReport {
  sources: SourceSyncReport[];
}

/**
 * Collapse the three user-facing sync flags into a single override value.
 * Throws (UserError) when --prefer-latest and --pinned are both passed.
 * `--update` is a documented alias for `--prefer-latest`.
 */
export function resolveOverride(flags: SyncOverrideFlags): SyncOverride | undefined {
  const wantsLatest = flags.preferLatest === true || flags.update === true;
  const wantsPinned = flags.pinned === true;
  if (wantsLatest && wantsPinned) {
    throw new UserError(
      'ccpp sync: --prefer-latest and --pinned are mutually exclusive; pick one.',
    );
  }
  if (wantsLatest) return 'latest';
  if (wantsPinned) return 'pinned';
  return undefined;
}

export function effectivePolicy(
  source: ConfigSource,
  config: CcppConfig,
  override: SyncOverride | undefined,
): SyncPolicy {
  if (override !== undefined) return override;
  if (source.policy !== undefined) return source.policy;
  if (config.syncPolicy !== undefined) return config.syncPolicy;
  return 'pinned';
}

/**
 * Policy-aware sync.
 *
 * v0.1.1 scope: the `policy` value is resolved, reported, and recorded, but
 * both `pinned` and `latest` perform the same network dance — fetch the source
 * ref tip, apply the manifest, advance the lockfile. The user-visible
 * distinction (diff-preview prompt on `pinned`, silent apply on `latest` +
 * `autoAccept`) lands in task ccpp-v011-diff-preview-autoaccept. Keeping the
 * behaviors identical here is deliberate — it preserves backwards-compat with
 * every existing v0.1.0 integration test while the policy plumbing settles.
 */
export async function runSync(opts: RunSyncOpts): Promise<SyncReport> {
  const config = await readConfig(opts.configPath).catch((err: Error) => {
    throw new UserError(err.message);
  });
  if (!config) {
    throw new UserError(
      `No ${CONFIG_FILENAME} at ${opts.configPath}. Run \`ccpp init\` first or pass --config <path>.`,
    );
  }
  if (config.sources.length === 0) {
    if (!opts.quiet) {
      process.stdout.write(`${yellow('!')} config has no sources; nothing to sync.\n`);
    }
    return { sources: [] };
  }

  const lockfile = await readLockfile(opts.lockfilePath).catch((err: Error) => {
    throw new UserError(err.message);
  });

  const perSource: SourceSyncReport[] = [];
  const allConflicts: Conflict[] = [];

  for (const source of config.sources) {
    const policy = effectivePolicy(source, config, opts.override);
    const priorSha = lockfile.sources[source.url]?.sha ?? null;

    const cloneOpts: Parameters<typeof cloneOrUpdate>[1] = {};
    if (source.ref) cloneOpts.ref = source.ref;

    let synced: Awaited<ReturnType<typeof cloneOrUpdate>>;
    try {
      synced = await cloneOrUpdate(source.url, cloneOpts);
    } catch (err) {
      throw new EnvError(`${source.url}: ${(err as Error).message}`);
    }

    const manifest = await parseManifest(synced.localPath).catch((err: Error) => {
      throw new EnvError(`${source.url}: ${err.message}`);
    });

    const priorDests = Object.entries(lockfile.installed)
      .filter(([, entry]) => entry.sourceUrl === source.url)
      .map(([dest]) => dest);

    const result = await applyManifest({
      manifest,
      sourceUrl: source.url,
      sourceSha: synced.sha,
      claudeHome: opts.claudeHome,
      lockfile,
      preferredSources: config.preferredSources ?? {},
    });

    lockfile.sources[source.url] = {
      sha: synced.sha,
      ref: synced.ref,
      lastSync: new Date().toISOString(),
    };

    const current = new Set([
      ...result.installed,
      ...result.updated,
      ...result.unchanged,
    ]);
    const removed = priorDests.filter((p) => !current.has(p));

    perSource.push({
      url: source.url,
      policy,
      priorSha,
      sha: synced.sha,
      ref: synced.ref,
      installed: result.installed,
      updated: result.updated,
      unchanged: result.unchanged,
      removed,
      conflicts: result.conflicts,
      backups: result.backups,
    });
    allConflicts.push(...result.conflicts);

    if (!opts.quiet && !opts.json) {
      const priorShort = priorSha ? priorSha.slice(0, 7) : '(new)';
      const newShort = synced.sha.slice(0, 7);
      process.stdout.write(
        `${green('✓')} ${source.url}  ${dim(`policy=${policy}`)}  SHA: ${priorShort} -> ${newShort}  (${result.installed.length} added, ${result.updated.length} modified, ${removed.length} removed)\n`,
      );
    }
  }

  await writeLockfile(opts.lockfilePath, lockfile);

  const report: SyncReport = { sources: perSource };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }

  if (allConflicts.length > 0) {
    throw new CollisionError(formatCollisionMessage(allConflicts), allConflicts);
  }

  return report;
}

function formatCollisionMessage(conflicts: Conflict[]): string {
  const lines = [`${conflicts.length} collision(s) unresolved:`];
  for (const c of conflicts) {
    lines.push(`  ${c.name}: ${c.currentSourceUrl} vs ${c.incomingSourceUrl}`);
  }
  lines.push(
    'Resolve by adding `preferredSources` entries to ccpp.config.json, then re-running sync.',
  );
  return lines.join('\n');
}
