import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { readConfig, writeConfig } from '../lib/config.js';
import { UserError } from '../lib/errors.js';
import { pathExists } from '../lib/fsutil.js';
import { parseRepoUrl } from '../lib/git.js';
import { readLockfile, writeLockfile } from '../lib/lockfile.js';
import { dim, green } from '../lib/term.js';
import type { Lockfile } from '../lib/types.js';
import { type ResolvedCommon, log } from './shared.js';

export interface RunUninstallOpts extends ResolvedCommon {
  /** A source identifier — full URL, repo basename, or any name resolveSourceForUninstall accepts. */
  name: string;
}

/**
 * Drop every file installed from `name`'s source from `~/.claude/`, remove
 * the matching lockfile entries, and prune `name` from `ccpp.config.json`.
 * Files are renamed to `.bak.<ts>` rather than deleted outright.
 *
 * Persistence ordering: the lockfile + config writes (truth-of-record) commit
 * BEFORE the file renames. If a crash interrupts the renames, the lockfile is
 * already consistent ("source X is gone") and the user just has stale files
 * in `~/.claude/` they can manually clean up. The previous order (rename then
 * write lockfile) could leave the lockfile claiming files that were already
 * renamed away.
 */
export async function runUninstall(opts: RunUninstallOpts): Promise<void> {
  if (typeof opts.name !== 'string' || opts.name.length === 0) {
    throw new UserError('ccpp uninstall: missing <name> argument');
  }
  const lockfile = await readLockfile(opts.lockfilePath).catch((err: Error) => {
    throw new UserError(err.message);
  });

  const target = resolveSourceForUninstall(lockfile, opts.name);
  if (!target) {
    throw new UserError(
      `No installed source matches "${opts.name}". Try \`ccpp list\` to see installed sources.`,
    );
  }

  // 1. Snapshot what we're about to remove (read-only).
  const destinations = Object.entries(lockfile.installed)
    .filter(([, entry]) => entry.sourceUrl === target)
    .map(([dest]) => dest);

  // 2. Mutate the in-memory lockfile (drop entries for this source).
  for (const dest of destinations) delete lockfile.installed[dest];
  delete lockfile.sources[target];

  // 3. Mutate the in-memory config (if present and source is listed).
  const config = await readConfig(opts.configPath).catch((err: Error) => {
    // Don't fail the uninstall just because the config is unreadable —
    // the lockfile is the source of truth for what got installed.
    process.stderr.write(`! config read failed; skipping config update: ${err.message}\n`);
    return null;
  });
  let configChanged = false;
  if (config) {
    const before = config.sources.length;
    config.sources = config.sources.filter((s) => s.url !== target);
    configChanged = config.sources.length !== before;
  }

  // 4. Commit lockfile + config (truth-of-record) BEFORE any irreversible disk op.
  await writeLockfile(opts.lockfilePath, lockfile);
  if (config && configChanged) {
    await writeConfig(opts.configPath, config);
  }

  // 5. Best-effort rename files to .bak.<ts>. Failures here leave the lockfile
  //    consistent (files are no longer tracked); user manually deletes leftovers.
  const removed: string[] = [];
  const backups: string[] = [];
  for (const dest of destinations) {
    if (await pathExists(dest)) {
      const backupPath = `${dest}.bak.${backupStamp()}`;
      await fs.rename(dest, backupPath);
      backups.push(backupPath);
    }
    removed.push(dest);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ source: target, removed, backups })}\n`);
    return;
  }
  log(
    `${green('✓')} uninstalled ${target} — ${removed.length} file(s) removed, ${backups.length} backup(s) kept`,
    opts,
  );
  for (const bak of backups) log(`  ${dim(bak)}`, opts);
}

function backupStamp(): string {
  // ISO timestamp + 4 hex chars — same shape as installer.ts:backupStamp.
  // Inlined here (rather than imported) to keep installer.ts's helper private.
  const ts = new Date().toISOString().replace(/:/g, '-');
  return `${ts}-${randomBytes(2).toString('hex')}`;
}

/**
 * Map a user-supplied identifier (full URL, repo basename, or anything that
 * matches an installed entry's sourceUrl) to the canonical source URL stored
 * in the lockfile. Returns null when no match is found.
 */
export function resolveSourceForUninstall(lockfile: Lockfile, name: string): string | null {
  if (lockfile.sources[name]) return name;
  for (const url of Object.keys(lockfile.sources)) {
    try {
      const { repo } = parseRepoUrl(url);
      if (repo === name) return url;
    } catch {
      // ignore parse failures — fall through to the next source
    }
  }
  // Fallback: match against any installed entry's sourceUrl
  for (const entry of Object.values(lockfile.installed)) {
    if (entry.sourceUrl === name) return entry.sourceUrl;
  }
  return null;
}
