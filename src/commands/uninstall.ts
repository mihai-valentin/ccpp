import { readConfig, writeConfig } from '../lib/config.js';
import { UserError } from '../lib/errors.js';
import { parseRepoUrl } from '../lib/git.js';
import { removeFromLockfile } from '../lib/installer.js';
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

  const result = await removeFromLockfile({
    name: target,
    claudeHome: opts.claudeHome,
    lockfile,
  });

  // Also drop from config.sources if present.
  const config = await readConfig(opts.configPath).catch(() => null);
  if (config) {
    const before = config.sources.length;
    config.sources = config.sources.filter((s) => s.url !== target);
    if (config.sources.length !== before) {
      await writeConfig(opts.configPath, config);
    }
  }

  await writeLockfile(opts.lockfilePath, lockfile);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ source: target, ...result })}\n`);
    return;
  }
  log(
    `${green('✓')} uninstalled ${target} — ${result.removed.length} file(s) removed, ${result.backups.length} backup(s) kept`,
    opts,
  );
  for (const bak of result.backups) log(`  ${dim(bak)}`, opts);
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
