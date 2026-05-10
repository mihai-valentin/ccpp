import {
  CONFIG_FILENAME,
  type CcppConfig,
  type ConfigSource,
  type SyncPolicy,
  readConfig,
} from '../lib/config.js';
import { type Changeset, computeChangeset, hasChanges } from '../lib/diff.js';
import { CollisionError, EnvError, UserError } from '../lib/errors.js';
import { cloneOrUpdate } from '../lib/git.js';
import { applyManifest } from '../lib/installer.js';
import { readLockfile, writeLockfile } from '../lib/lockfile.js';
import { type SyncOutcome, type SyncTrigger, appendSyncLog } from '../lib/log.js';
import { type ParseManifestResult, parseManifest } from '../lib/manifest.js';
import { effectiveAutoAccept, effectivePolicy } from '../lib/policy.js';
import { dim, formatShortSha, green, promptYesNo, yellow } from '../lib/term.js';
import type { Conflict, Lockfile } from '../lib/types.js';

export type SyncOverride = SyncPolicy;

export interface SyncOverrideFlags {
  preferLatest?: boolean;
  pinned?: boolean;
  update?: boolean;
}

export type ApplyStatus = 'applied' | 'no-changes' | 'skipped-no-prompt' | 'user-declined';

export interface RunSyncOpts {
  configPath: string;
  lockfilePath: string;
  claudeHome: string;
  json: boolean;
  quiet: boolean;
  override?: SyncOverride;
  /** `--auto-accept` CLI flag — bypass the diff-preview prompt for this run. */
  autoAccept?: boolean;
  /** `--verbose` CLI flag — expand per-file paths in the diff summary. */
  verbose?: boolean;
  /** `--trigger` CLI flag — tags log entries. Defaults to 'manual'. */
  trigger?: SyncTrigger;
  /** Override the sync.log path (tests + non-default CCPP_HOME). */
  logPath?: string;
  /**
   * DI hook for tests — swap the stdin-backed prompt for a deterministic one.
   * Called only when the decision-tree would otherwise prompt interactively
   * (i.e. no autoAccept, not JSON mode). If omitted and the real stdin is not
   * a TTY, the source is skipped with `skipped-no-prompt` instead of blocking.
   */
  confirm?: (prompt: string) => Promise<boolean> | boolean;
  /**
   * DI hook for tests — override the TTY check. Used alongside `confirm` to
   * simulate an interactive terminal in-process. Defaults to process.stdin.isTTY.
   */
  isTTY?: boolean;
}

export interface SourceSyncReport {
  url: string;
  policy: SyncPolicy;
  priorSha: string | null;
  sha: string;
  ref: string;
  changeset: Changeset;
  applyStatus: ApplyStatus;
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

/**
 * Policy-aware sync with a diff-preview trust gate.
 *
 * For each source we compute a {@link Changeset} (dry-run against the current
 * `~/.claude/` state). If there are changes we decide how to proceed, in order:
 *
 * 1. Empty changeset → apply (no-op on disk, keeps lockfile.lastSync fresh).
 * 2. `autoAccept` from config OR `--auto-accept` flag → apply silently.
 * 3. `--json` OR non-TTY stdin (e.g. hook context) → skip with `skipped-no-prompt`.
 * 4. Otherwise prompt `[y/N]`; y → apply, n/EOF → `user-declined`.
 *
 * Skipped sources leave the lockfile `sources` entry at its prior SHA — the
 * on-disk state is the lockfile's source of truth. A skipped run is exit 0;
 * hook-triggered syncs must never block a Claude Code session.
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

  const ctx: SyncContext = {
    opts,
    config,
    lockfile,
    trigger: opts.trigger ?? 'manual',
    autoAcceptEffective: effectiveAutoAccept(opts.autoAccept, config),
    isTTY: opts.isTTY ?? Boolean(process.stdin.isTTY),
  };

  const perSource: SourceSyncReport[] = [];
  const allConflicts: Conflict[] = [];

  for (const source of config.sources) {
    const report = await syncOneSource(source, ctx);
    perSource.push(report);
    allConflicts.push(...report.conflicts);
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

/* -------------------- per-source pipeline -------------------- */

interface SyncContext {
  opts: RunSyncOpts;
  config: CcppConfig;
  lockfile: Lockfile;
  trigger: SyncTrigger;
  autoAcceptEffective: boolean;
  isTTY: boolean;
}

/**
 * Drive one source through clone → parse → diff → decide → apply/skip.
 * Returns the per-source report; collisions are also surfaced via
 * `report.conflicts` so the caller can aggregate them after the loop.
 */
async function syncOneSource(source: ConfigSource, ctx: SyncContext): Promise<SourceSyncReport> {
  const policy = effectivePolicy(source, ctx.config, ctx.opts.override);
  const priorSha = ctx.lockfile.sources[source.url]?.sha ?? null;

  const { synced, manifest } = await cloneAndParseSource(source, ctx);

  const changeset = await computeChangeset({
    manifest,
    sourceUrl: source.url,
    sourceSha: synced.sha,
    claudeHome: ctx.opts.claudeHome,
    lockfile: ctx.lockfile,
  });

  const applyStatus = await decideApply({
    changeset,
    source,
    policy,
    autoAcceptEffective: ctx.autoAcceptEffective,
    json: ctx.opts.json,
    quiet: ctx.opts.quiet,
    verbose: ctx.opts.verbose === true,
    confirm: ctx.opts.confirm,
    isTTY: ctx.isTTY,
  });

  if (applyStatus === 'applied' || applyStatus === 'no-changes') {
    return await applySource(
      source,
      ctx,
      synced,
      manifest,
      changeset,
      applyStatus,
      priorSha,
      policy,
    );
  }
  return await recordSkip(source, ctx, synced, changeset, applyStatus, priorSha, policy);
}

/**
 * Clone (or fetch-update) the source, then parse its manifest. Logs and
 * re-throws as EnvError on either failure — the two error paths used to be
 * duplicated inline in runSync.
 */
async function cloneAndParseSource(
  source: ConfigSource,
  ctx: SyncContext,
): Promise<{ synced: Awaited<ReturnType<typeof cloneOrUpdate>>; manifest: ParseManifestResult }> {
  const cloneOpts: Parameters<typeof cloneOrUpdate>[1] = {};
  if (source.ref) cloneOpts.ref = source.ref;

  let synced: Awaited<ReturnType<typeof cloneOrUpdate>>;
  try {
    synced = await cloneOrUpdate(source.url, cloneOpts);
  } catch (err) {
    await logSyncError(source.url, err, ctx);
    throw new EnvError(`${source.url}: ${(err as Error).message}`);
  }

  let manifest: ParseManifestResult;
  try {
    manifest = await parseManifest(synced.localPath);
  } catch (err) {
    await logSyncError(source.url, err, ctx);
    throw new EnvError(`${source.url}: ${(err as Error).message}`);
  }
  for (const w of manifest.warnings) {
    process.stderr.write(`! ${source.url}: ${w.message}\n`);
  }

  return { synced, manifest };
}

/**
 * Apply the manifest to `~/.claude/`, update the lockfile pin, log the
 * outcome (success or collision), and assemble the per-source report.
 */
async function applySource(
  source: ConfigSource,
  ctx: SyncContext,
  synced: Awaited<ReturnType<typeof cloneOrUpdate>>,
  manifest: ParseManifestResult,
  changeset: Changeset,
  applyStatus: ApplyStatus,
  priorSha: string | null,
  policy: SyncPolicy,
): Promise<SourceSyncReport> {
  // Snapshot the destinations this source previously owned so we can
  // compute "files removed from the manifest since last sync" after apply.
  const priorDests = Object.entries(ctx.lockfile.installed)
    .filter(([, entry]) => entry.sourceUrl === source.url)
    .map(([dest]) => dest);

  const result = await applyManifest({
    manifest,
    sourceUrl: source.url,
    sourceSha: synced.sha,
    claudeHome: ctx.opts.claudeHome,
    lockfile: ctx.lockfile,
    preferredSources: ctx.config.preferredSources ?? {},
  });

  ctx.lockfile.sources[source.url] = {
    sha: synced.sha,
    ref: synced.ref,
    lastSync: new Date().toISOString(),
  };

  const current = new Set([...result.installed, ...result.updated, ...result.unchanged]);
  const removed = priorDests.filter((p) => !current.has(p));

  if (!ctx.opts.quiet && !ctx.opts.json) {
    const priorShort = priorSha ? formatShortSha(priorSha) : '(new)';
    const newShort = formatShortSha(synced.sha);
    const suffix = applyStatus === 'no-changes' ? dim(' (up-to-date)') : '';
    process.stdout.write(
      `${green('✓')} ${source.url}  ${dim(`policy=${policy}`)}  SHA: ${priorShort} -> ${newShort}  (${result.installed.length} added, ${result.updated.length} modified, ${removed.length} removed)${suffix}\n`,
    );
  }

  const outcome: SyncOutcome = result.conflicts.length > 0 ? 'error' : 'success';
  await appendSyncLog(
    {
      timestamp: new Date().toISOString(),
      trigger: ctx.trigger,
      outcome,
      sourceUrl: source.url,
      changeset: changesetCounts(changeset),
      ...(result.conflicts.length > 0 && {
        error: `${result.conflicts.length} collision(s) unresolved`,
      }),
    },
    ctx.opts.logPath,
  );

  return {
    url: source.url,
    policy,
    priorSha,
    sha: synced.sha,
    ref: synced.ref,
    changeset,
    applyStatus,
    installed: result.installed,
    updated: result.updated,
    unchanged: result.unchanged,
    removed,
    conflicts: result.conflicts,
    backups: result.backups,
  };
}

/**
 * Build the per-source report for a skipped source — leaves the lockfile
 * `sources` entry untouched at priorSha. Emits a human-readable skip line
 * (unless --json) and a structured skip event to sync.log.
 */
async function recordSkip(
  source: ConfigSource,
  ctx: SyncContext,
  synced: Awaited<ReturnType<typeof cloneOrUpdate>>,
  changeset: Changeset,
  applyStatus: ApplyStatus,
  priorSha: string | null,
  policy: SyncPolicy,
): Promise<SourceSyncReport> {
  if (!ctx.opts.json) {
    logSkip(source.url, policy, applyStatus, changeset, ctx.opts);
  }

  await appendSyncLog(
    {
      timestamp: new Date().toISOString(),
      trigger: ctx.trigger,
      outcome: 'skipped',
      sourceUrl: source.url,
      changeset: changesetCounts(changeset),
    },
    ctx.opts.logPath,
  );

  return {
    url: source.url,
    policy,
    priorSha,
    sha: priorSha ?? synced.sha,
    ref: synced.ref,
    changeset,
    applyStatus,
    installed: [],
    updated: [],
    unchanged: [],
    removed: [],
    conflicts: [],
    backups: [],
  };
}

/** Append an `outcome: error` entry to sync.log. Used by the clone + parse paths. */
async function logSyncError(sourceUrl: string, err: unknown, ctx: SyncContext): Promise<void> {
  await appendSyncLog(
    {
      timestamp: new Date().toISOString(),
      trigger: ctx.trigger,
      outcome: 'error',
      sourceUrl,
      error: (err as Error).message,
    },
    ctx.opts.logPath,
  );
}

function changesetCounts(changeset: Changeset): {
  added: number;
  modified: number;
  removed: number;
} {
  return {
    added: changeset.added.length,
    modified: changeset.modified.length,
    removed: changeset.removed.length,
  };
}

/* -------------------- decision + presentation -------------------- */

interface DecideApplyOpts {
  changeset: Changeset;
  source: ConfigSource;
  policy: SyncPolicy;
  autoAcceptEffective: boolean;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  confirm?: (prompt: string) => Promise<boolean> | boolean;
  isTTY: boolean;
}

async function decideApply(d: DecideApplyOpts): Promise<ApplyStatus> {
  if (!hasChanges(d.changeset)) return 'no-changes';
  if (d.autoAcceptEffective) return 'applied';
  if (d.json) return 'skipped-no-prompt';

  const proposal = renderProposal(d.source.url, d.policy, d.changeset, d.verbose);
  if (!d.quiet && !d.json) process.stdout.write(`${proposal}\n`);

  if (d.confirm !== undefined) {
    return (await d.confirm(proposal)) ? 'applied' : 'user-declined';
  }
  if (!d.isTTY) return 'skipped-no-prompt';
  return (await promptYesNo('Apply? [y/N]')) ? 'applied' : 'user-declined';
}

function renderProposal(
  url: string,
  policy: SyncPolicy,
  changeset: Changeset,
  verbose: boolean,
): string {
  const header = `Source ${url} (policy=${policy}) proposes: +${changeset.added.length} added, ~${changeset.modified.length} modified, -${changeset.removed.length} removed.`;
  if (!verbose) return header;
  const lines: string[] = [header];
  for (const p of changeset.added) lines.push(`  + ${p}`);
  for (const p of changeset.modified) lines.push(`  ~ ${p}`);
  for (const p of changeset.removed) lines.push(`  - ${p}`);
  return lines.join('\n');
}

function logSkip(
  url: string,
  policy: SyncPolicy,
  applyStatus: ApplyStatus,
  changeset: Changeset,
  opts: Pick<RunSyncOpts, 'quiet'>,
): void {
  if (opts.quiet) return;
  const summary = `+${changeset.added.length}/~${changeset.modified.length}/-${changeset.removed.length}`;
  if (applyStatus === 'skipped-no-prompt') {
    process.stderr.write(
      `${yellow('!')} ${url}  ${dim(`policy=${policy}`)}  skipped (${summary}) — autoAccept is false and prompt not available; set autoAccept: true or run \`ccpp sync\` manually.\n`,
    );
  } else if (applyStatus === 'user-declined') {
    process.stderr.write(
      `${yellow('!')} ${url}  ${dim(`policy=${policy}`)}  skipped (${summary}) — user declined.\n`,
    );
  }
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
