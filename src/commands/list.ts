import { join } from 'node:path';
import { UserError } from '../lib/errors.js';
import { classifyDestination, claudeDirs } from '../lib/layout.js';
import { readLockfile } from '../lib/lockfile.js';
import { bold, dim, formatShortSha, formatTable } from '../lib/term.js';
import type { Lockfile } from '../lib/types.js';
import { type ResolvedCommon, log } from './shared.js';

export interface ListRow {
  name: string;
  type: 'command' | 'skill' | 'agent';
  sourceUrl: string;
  sha: string;
  lastSync: string;
  destPath: string;
}

/** Print every command, skill, and agent currently tracked by the lockfile. */
export async function runList(opts: ResolvedCommon): Promise<void> {
  const lockfile = await readLockfile(opts.lockfilePath).catch((err: Error) => {
    throw new UserError(err.message);
  });
  const rows = lockfileRows(lockfile, opts.claudeHome);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ rows })}\n`);
    return;
  }

  if (rows.length === 0) {
    log(dim('(nothing installed)'), opts);
    return;
  }

  const header = [bold('NAME'), bold('TYPE'), bold('SOURCE'), bold('SHA'), bold('LAST_SYNC')];
  const table = [
    header,
    ...rows.map((r) => [r.name, r.type, r.sourceUrl, formatShortSha(r.sha), r.lastSync]),
  ];
  for (const line of formatTable(table)) log(line, opts);
}

/**
 * Walk the lockfile and turn each `installed` entry into one ListRow per
 * resource (commands and agents are 1:1; skills collapse multi-file trees
 * to a single row keyed by the skill name + source).
 */
export function lockfileRows(lockfile: Lockfile, claudeHome: string): ListRow[] {
  const rows: ListRow[] = [];
  const dirs = claudeDirs(claudeHome);
  const seenSkills = new Set<string>();
  for (const [destPath, entry] of Object.entries(lockfile.installed)) {
    const cls = classifyDestination(destPath, claudeHome);
    if (!cls) continue;
    if (cls.kind === 'commands') {
      rows.push({
        name: cls.name,
        type: 'command',
        sourceUrl: entry.sourceUrl,
        sha: entry.sourceSha,
        lastSync: entry.installedAt,
        destPath,
      });
    } else if (cls.kind === 'agents') {
      rows.push({
        name: cls.name,
        type: 'agent',
        sourceUrl: entry.sourceUrl,
        sha: entry.sourceSha,
        lastSync: entry.installedAt,
        destPath,
      });
    } else if (cls.kind === 'skills' && cls.name.length > 0) {
      // Skills are directory-shaped — multiple lockfile entries map to one
      // logical row. Synthesize a destPath pointing at the skill's root
      // directory (not the per-file path the lockfile actually keys on)
      // so the list output reads as one row per skill, not one per file.
      const key = `${entry.sourceUrl}::${cls.name}`;
      if (seenSkills.has(key)) continue;
      seenSkills.add(key);
      rows.push({
        name: cls.name,
        type: 'skill',
        sourceUrl: entry.sourceUrl,
        sha: entry.sourceSha,
        lastSync: entry.installedAt,
        destPath: join(dirs.skillsDir, cls.name),
      });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  return rows;
}
