import { promises as fs } from 'node:fs';
import { pathExists, readFileSafe } from './fsutil.js';
import { planFiles } from './plan.js';
import type { Lockfile, ResolvedManifest } from './types.js';

/**
 * Dry-run diff of what an `applyManifest` invocation would do for a single
 * source, given the current filesystem state and lockfile. Collision /
 * preferredSources filtering is deliberately out of scope — applyManifest
 * handles that at write time; callers prompt the user off the raw proposal.
 */
export interface Changeset {
  /** Destination paths that would be created (no file present at destPath). */
  added: string[];
  /** Destination paths where the file exists but its bytes differ from source. */
  modified: string[];
  /**
   * Destination paths recorded in lockfile.installed for this source but absent
   * from the new manifest — upstream removals. (The disk file is not auto-deleted
   * by applyManifest in v0.1.1, but they still count as "gone from the source".)
   */
  removed: string[];
  /** Destination paths where bytes already match the source. */
  unchanged: string[];
}

export interface ComputeChangesetOptions {
  manifest: ResolvedManifest;
  sourceUrl: string;
  sourceSha: string;
  claudeHome: string;
  lockfile: Lockfile;
}

/**
 * Run the same plan that applyManifest would, then classify each entry by
 * comparing source bytes against `~/.claude/`. Plan rules live in
 * `lib/plan.ts` so this stays in lockstep with the installer.
 */
export async function computeChangeset(opts: ComputeChangesetOptions): Promise<Changeset> {
  const plan = planFiles(opts.manifest, opts.claudeHome);
  const changeset: Changeset = { added: [], modified: [], removed: [], unchanged: [] };

  const priorDests = new Set<string>();
  for (const [destPath, entry] of Object.entries(opts.lockfile.installed)) {
    if (entry.sourceUrl === opts.sourceUrl) priorDests.add(destPath);
  }

  for (const item of plan) {
    priorDests.delete(item.destPath);
    const destExists = await pathExists(item.destPath);
    if (!destExists) {
      changeset.added.push(item.destPath);
      continue;
    }
    // See fsutil.readFileSafe — refuses to follow symlinks from the source repo.
    // The destination read stays as fs.readFile: that path is inside the user's
    // own ~/.claude/ and isn't attacker-controlled.
    const [sourceBytes, destBytes] = await Promise.all([
      readFileSafe(item.sourceAbsolute),
      fs.readFile(item.destPath),
    ]);
    if (sourceBytes.equals(destBytes)) {
      changeset.unchanged.push(item.destPath);
    } else {
      changeset.modified.push(item.destPath);
    }
  }

  for (const dest of priorDests) changeset.removed.push(dest);

  // Stable ordering — callers render these paths in summaries and tests.
  changeset.added.sort();
  changeset.modified.sort();
  changeset.removed.sort();
  changeset.unchanged.sort();

  return changeset;
}

export function hasChanges(changeset: Changeset): boolean {
  return (
    changeset.added.length > 0 || changeset.modified.length > 0 || changeset.removed.length > 0
  );
}
