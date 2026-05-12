import { type CcppConfig, readConfig, writeConfig } from '../lib/config.js';
import { computeChangeset } from '../lib/diff.js';
import { EnvError, UserError } from '../lib/errors.js';
import { type CloneOrUpdateResult, cloneOrUpdate, parseRepoUrl } from '../lib/git.js';
import { readLockfile } from '../lib/lockfile.js';
import { parseManifest } from '../lib/manifest.js';
import { bold, dim, formatShortSha, green, isInteractive, yellow } from '../lib/term.js';
import type { Conflict } from '../lib/types.js';
import { splitUrlRef } from '../lib/url.js';
import {
  type InstallResult,
  type SyncSourceToDiskParams,
  interactiveConflictResolver,
  syncSourceToDisk,
} from './install.js';
import { type ResolvedCommon, log, warnIfTransientClaudeHome } from './shared.js';

interface CheckoutFlags {
  prefer?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

export interface RunCheckoutOpts extends ResolvedCommon, CheckoutFlags {
  /** Source identifier — full URL, repo basename, or `<url>@<ref>` shorthand. */
  source: string;
  /** Optional positional ref. Conflicts with a `@<ref>` carried by `source`. */
  ref?: string;
}

/**
 * Switch the active ref of an already-installed source.
 *
 * Why a separate verb: `ccpp install <existing-url>@<new-ref>` clones at the
 * new ref and updates the lockfile, but `installSource` deliberately leaves
 * `config.sources[i].ref` untouched on an existing entry — so the next
 * `ccpp sync` silently reverts the swap (since sync reads ref from config).
 *
 * Persistence order matches install: lockfile (via {@link syncSourceToDisk})
 * is written first, then config. A crash between the two leaves the lockfile
 * authoritative for the new ref while config still names the old ref — the
 * user re-runs checkout to reconcile.
 */
export async function runCheckout(opts: RunCheckoutOpts): Promise<void> {
  warnIfTransientClaudeHome(opts);

  const { url, ref } = resolveCheckoutTarget(opts);

  let config: CcppConfig;
  try {
    const loaded = await readConfig(opts.configPath);
    if (!loaded) {
      throw new UserError(
        `ccpp checkout: no ccpp.config.json at ${opts.configPath}. Run \`ccpp install <url>@<ref>\` first.`,
      );
    }
    config = loaded;
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError((err as Error).message);
  }

  const sourceEntry = resolveConfigSource(config, url);
  if (!sourceEntry) {
    throw new UserError(
      `ccpp checkout: "${opts.source}" is not in ccpp.config.json. Use \`ccpp install <url>@${ref}\` to add it as a new source.`,
    );
  }

  const fromRef = sourceEntry.ref;
  if (fromRef === ref) {
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          url: sourceEntry.url,
          fromRef,
          toRef: ref,
          noop: true,
        })}\n`,
      );
      return;
    }
    log(`${dim('•')} ${sourceEntry.url} already on ${ref} — no changes.`, opts);
    return;
  }

  if (opts.dryRun === true) {
    await emitDryRun(sourceEntry.url, fromRef, ref, opts);
    return;
  }

  const preferredSources: Record<string, string> = config.preferredSources
    ? { ...config.preferredSources }
    : {};

  const syncParams: SyncSourceToDiskParams = {
    url: sourceEntry.url,
    ref,
    common: opts,
    preferredSources,
    forcePreferIncoming: Boolean(opts.prefer) || Boolean(opts.yes),
  };
  // Same interactive-conflict-resolver gate as install: only when stdin is a
  // TTY and the user did not pre-pick a side via --prefer / --yes.
  if (!opts.prefer && !opts.yes && isInteractive()) {
    syncParams.resolveConflicts = (conflicts, incoming) =>
      interactiveConflictResolver(conflicts, incoming);
  }

  const { synced, result, conflictsResolved } = await syncSourceToDisk(syncParams);

  // Config mutation: swap the ref on the existing entry; record
  // preferredSources if collisions were resolved (mirrors install behavior).
  sourceEntry.ref = ref;
  if (Boolean(opts.prefer) || Boolean(opts.yes) || conflictsResolved) {
    config.preferredSources = preferredSources;
  }
  await writeConfig(opts.configPath, config);

  emitCheckoutSummary(sourceEntry.url, fromRef, ref, synced, result, opts);
}

/* -------------------- helpers -------------------- */

/**
 * Reconcile a `<source>@<ref>` shorthand with a positional `<ref>` arg.
 * Returns the canonical URL part (still possibly a short name — config
 * resolution happens after) and the agreed-upon ref. Throws if neither side
 * supplies a ref, or if both supply different refs.
 */
function resolveCheckoutTarget(opts: RunCheckoutOpts): { url: string; ref: string } {
  if (typeof opts.source !== 'string' || opts.source.length === 0) {
    throw new UserError('ccpp checkout: missing <source> argument.');
  }
  const split = splitUrlRef(opts.source);
  const shorthandRef = split.ref;
  if (shorthandRef !== undefined && opts.ref !== undefined && shorthandRef !== opts.ref) {
    throw new UserError(
      `ccpp checkout: ref conflict — <source> carries @${shorthandRef} but positional ref is ${opts.ref}. Pick one.`,
    );
  }
  const ref = opts.ref ?? shorthandRef;
  if (ref === undefined || ref.length === 0) {
    throw new UserError(
      'ccpp checkout: missing <ref>. Pass it as a second positional or via <source>@<ref> shorthand.',
    );
  }
  return { url: split.url, ref };
}

/**
 * Look up `name` in config.sources by exact URL match first, then by repo
 * basename (parsed via {@link parseRepoUrl}). Returns the live reference
 * into config.sources so callers can mutate `.ref` in place.
 */
function resolveConfigSource(
  config: CcppConfig,
  name: string,
): CcppConfig['sources'][number] | null {
  const exact = config.sources.find((s) => s.url === name);
  if (exact) return exact;
  for (const s of config.sources) {
    try {
      const { repo } = parseRepoUrl(s.url);
      if (repo === name) return s;
    } catch {
      // unparseable URL in config — skip, fall through to "not found"
    }
  }
  return null;
}

async function emitDryRun(
  url: string,
  fromRef: string | undefined,
  toRef: string,
  opts: RunCheckoutOpts,
): Promise<void> {
  // Dry-run: clone + parse + diff against current disk state, without
  // touching the lockfile, config, or ~/.claude/.
  const cloneOpts: Parameters<typeof cloneOrUpdate>[1] = { ref: toRef };
  let synced: CloneOrUpdateResult;
  try {
    synced = await cloneOrUpdate(url, cloneOpts);
  } catch (err) {
    throw new EnvError((err as Error).message);
  }

  const manifest = await parseManifest(synced.localPath).catch((err: Error) => {
    throw new EnvError(err.message);
  });
  for (const w of manifest.warnings) {
    process.stderr.write(`${yellow('!')} ${w.message}\n`);
  }

  const lockfile = await readLockfile(opts.lockfilePath).catch((err: Error) => {
    throw new UserError(err.message);
  });

  const changeset = await computeChangeset({
    manifest,
    sourceUrl: url,
    sourceSha: synced.sha,
    claudeHome: opts.claudeHome,
    lockfile,
  });

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        url,
        fromRef: fromRef ?? null,
        toRef,
        toSha: synced.sha,
        dryRun: true,
        added: changeset.added,
        modified: changeset.modified,
        removed: changeset.removed,
        unchanged: changeset.unchanged,
      })}\n`,
    );
    return;
  }
  const fromLabel = fromRef ?? '(unset)';
  log(
    `${dim('•')} ${bold('dry-run')} ${url}: ${fromLabel} → ${toRef} ${dim(`@${formatShortSha(synced.sha)}`)}`,
    opts,
  );
  log(
    `  +${changeset.added.length} added, ~${changeset.modified.length} modified, -${changeset.removed.length} removed, =${changeset.unchanged.length} unchanged`,
    opts,
  );
  log(`  ${dim('no writes performed; re-run without --dry-run to apply.')}`, opts);
}

function emitCheckoutSummary(
  url: string,
  fromRef: string | undefined,
  toRef: string,
  synced: CloneOrUpdateResult,
  result: InstallResult,
  opts: RunCheckoutOpts,
): void {
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        url,
        fromRef: fromRef ?? null,
        toRef,
        toSha: synced.sha,
        installed: result.installed,
        updated: result.updated,
        unchanged: result.unchanged,
        removed: result.removed,
        backups: result.backups,
        conflicts: result.conflicts,
      })}\n`,
    );
    return;
  }
  const fromLabel = fromRef ?? '(unset)';
  log(
    `${green('✓')} ${url} switched ${fromLabel} → ${toRef} ${dim(`@${formatShortSha(synced.sha)}`)}`,
    opts,
  );
  const removedSuffix = result.removed.length > 0 ? `, ${result.removed.length} removed` : '';
  log(
    `  ${result.installed.length} new, ${result.updated.length} updated, ${result.unchanged.length} unchanged${removedSuffix}`,
    opts,
  );
  log(`  ${dim('config:')} ${opts.configPath}`, opts);
  if (result.backups.length > 0) {
    log(`  ${yellow('!')} ${result.backups.length} file(s) backed up:`, opts);
    for (const bak of result.backups) log(`    ${dim(bak)}`, opts);
  }
}

/**
 * Re-export for tests that want to mock the conflict surface without pulling
 * in install.ts internals.
 */
export type CheckoutConflictResolver = (
  conflicts: Conflict[],
  incomingUrl: string,
) => Promise<Record<string, string> | null>;
