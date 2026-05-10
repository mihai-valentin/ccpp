import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathExists, readFileSafe } from './fsutil.js';
import { type PlannedFile, planFiles } from './plan.js';
import type { Conflict, LockInstalledEntry, Lockfile, ResolvedManifest } from './types.js';

export interface ApplyManifestOptions {
  manifest: ResolvedManifest;
  sourceUrl: string;
  sourceSha: string;
  claudeHome: string;
  lockfile: Lockfile;
  /** name → preferred sourceUrl. Wins collisions. */
  preferredSources?: Record<string, string>;
}

export interface ApplyManifestResult {
  installed: string[];
  updated: string[];
  unchanged: string[];
  conflicts: Conflict[];
  backups: string[];
}

export interface RemoveFromLockfileOptions {
  /** Source URL whose installed files should be removed. */
  sourceUrl: string;
  claudeHome: string;
  lockfile: Lockfile;
}

export interface RemoveFromLockfileResult {
  removed: string[];
  backups: string[];
}

/**
 * Apply a parsed manifest to `<claudeHome>/` — write commands, skills, agents,
 * and lockfile entries. Non-destructive on conflict: returns a {@link Conflict}
 * list the caller surfaces to the user. Always backs up an existing file
 * whose bytes differ from what is about to be written.
 *
 * Internal phases:
 *
 *   1. {@link planFiles} (pure, in `lib/plan.ts`) — derive destination paths.
 *   2. {@link preparePlan} — read source bytes, classify each plan item as
 *      skip / unchanged / conflict / write. Lockfile entries for unchanged
 *      files are recorded here.
 *   3. {@link stagePlan} — stage every byte-to-write under
 *      `<claudeHome>/.ccpp-staging-<id>/`. If any read or staging write fails,
 *      the staging tree is removed and `~/.claude/` is left untouched.
 *   4. {@link commitStaged} — atomic-rename each staged file into place,
 *      backing up any pre-existing differing target to `.bak.<timestamp>`.
 *      Mutates the lockfile as files commit.
 *
 * Phase 4 is best-effort atomic per file (single `fs.rename` on the same
 * filesystem) but not cross-file transactional — a phase-4 failure midway
 * leaves earlier swaps committed. This is rare in practice once parent
 * dirs exist; the user still has `.bak` files plus the staging tree (NOT
 * cleaned on phase-4 failure) for manual recovery.
 *
 * Lockfile mutation note: phase 2 records lockfile entries for *unchanged*
 * items (since they need no on-disk write). Even when the eventual
 * toWrite list is empty and applyManifest short-circuits before phase 3,
 * the lockfile has already been mutated in place — the caller is expected
 * to persist it. This is intentional: an unchanged file should still
 * record its current source pin so subsequent removals know about it.
 */
export async function applyManifest(opts: ApplyManifestOptions): Promise<ApplyManifestResult> {
  const plan = planFiles(opts.manifest, opts.claudeHome);
  const now = new Date().toISOString();

  const prepared = await preparePlan(plan, opts, now);

  if (prepared.toWrite.length === 0) {
    return {
      installed: [],
      updated: [],
      unchanged: prepared.unchanged,
      conflicts: prepared.conflicts,
      backups: [],
    };
  }

  const staged = await stagePlan(prepared.toWrite, opts.claudeHome);
  const committed = await commitStaged(staged, opts, now);

  return {
    installed: committed.installed,
    updated: committed.updated,
    unchanged: prepared.unchanged,
    conflicts: prepared.conflicts,
    backups: committed.backups,
  };
}

/**
 * Remove every file installed from the given source and delete its lockfile
 * entries. Files that still exist on disk are renamed to `<path>.bak.<ts>`
 * rather than deleted outright, so recovery is always possible.
 */
export async function removeFromLockfile(
  opts: RemoveFromLockfileOptions,
): Promise<RemoveFromLockfileResult> {
  const { sourceUrl } = opts;
  const toRemove: string[] = [];
  for (const [destPath, entry] of Object.entries(opts.lockfile.installed)) {
    if (entry.sourceUrl === sourceUrl) toRemove.push(destPath);
  }

  const removed: string[] = [];
  const backups: string[] = [];
  for (const destPath of toRemove) {
    if (await pathExists(destPath)) {
      const backupPath = `${destPath}.bak.${backupStamp()}`;
      await fs.rename(destPath, backupPath);
      backups.push(backupPath);
    }
    delete opts.lockfile.installed[destPath];
    removed.push(destPath);
  }
  delete opts.lockfile.sources[sourceUrl];

  return { removed, backups };
}

/* -------------------- internal: prepare / stage / commit -------------------- */

interface ToWriteItem {
  item: PlannedFile;
  sourceBytes: Buffer;
  destExists: boolean;
}

interface StagedItem {
  item: PlannedFile;
  stagePath: string;
  destExists: boolean;
}

interface PreparedPlan {
  unchanged: string[];
  conflicts: Conflict[];
  toWrite: ToWriteItem[];
}

interface StagedPlan {
  stagingRoot: string;
  items: StagedItem[];
}

/**
 * Phase 2 — classify each plan item by reading source bytes and comparing
 * with the destination. Records lockfile entries for unchanged items
 * (since they need no on-disk write but should still be tracked under the
 * current source).
 */
async function preparePlan(
  plan: PlannedFile[],
  opts: ApplyManifestOptions,
  now: string,
): Promise<PreparedPlan> {
  const result: PreparedPlan = { unchanged: [], conflicts: [], toWrite: [] };

  for (const item of plan) {
    const existingEntry = opts.lockfile.installed[item.destPath];
    if (existingEntry && existingEntry.sourceUrl !== opts.sourceUrl) {
      const preferred = opts.preferredSources?.[item.name];
      if (preferred === opts.sourceUrl) {
        // Incoming source explicitly preferred → fall through to write.
      } else if (preferred === existingEntry.sourceUrl) {
        // Existing source explicitly preferred → silently skip.
        continue;
      } else {
        result.conflicts.push({
          destPath: item.destPath,
          currentSourceUrl: existingEntry.sourceUrl,
          incomingSourceUrl: opts.sourceUrl,
          name: item.name,
        });
        continue;
      }
    }

    // readFileSafe refuses to follow symlinks — source repos are
    // partially-trusted input and a symlink could redirect the read to
    // anything on the filesystem, including files Claude Code shouldn't see.
    const sourceBytes = await readFileSafe(item.sourceAbsolute);
    const destExists = await pathExists(item.destPath);

    if (destExists) {
      const destBytes = await fs.readFile(item.destPath);
      if (sourceBytes.equals(destBytes)) {
        result.unchanged.push(item.destPath);
        opts.lockfile.installed[item.destPath] = lockEntry(item, opts, now);
        continue;
      }
    }

    result.toWrite.push({ item, sourceBytes, destExists });
  }

  return result;
}

/**
 * Phase 3 — stage every byte-to-write under
 * `<claudeHome>/.ccpp-staging-<id>/`. The staging tree mirrors the dest
 * tree under claudeHome so the eventual rename is on the same filesystem
 * (cheap and atomic). On any failure during this phase, the staging tree
 * is rm -rf'd and the error is re-thrown — `~/.claude/` is left untouched.
 */
async function stagePlan(toWrite: ToWriteItem[], claudeHome: string): Promise<StagedPlan> {
  const stagingId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const stagingRoot = join(claudeHome, `.ccpp-staging-${stagingId}`);
  const items: StagedItem[] = [];

  try {
    for (const { item, sourceBytes, destExists } of toWrite) {
      const rel = relative(claudeHome, item.destPath);
      const stagePath = join(stagingRoot, rel);
      await fs.mkdir(dirname(stagePath), { recursive: true });
      await fs.writeFile(stagePath, sourceBytes);
      items.push({ item, stagePath, destExists });
    }
  } catch (err) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw err;
  }

  return { stagingRoot, items };
}

/**
 * Phase 4 — atomic-rename each staged file into place. On the same
 * filesystem this is an atomic rename per file; cross-file atomicity is
 * best-effort. Mutates the lockfile as files commit. The staging tree is
 * removed on success; on partial failure it stays in place so the user
 * can recover the staged content manually.
 */
async function commitStaged(
  staged: StagedPlan,
  opts: ApplyManifestOptions,
  now: string,
): Promise<{ installed: string[]; updated: string[]; backups: string[] }> {
  const out = {
    installed: [] as string[],
    updated: [] as string[],
    backups: [] as string[],
  };

  for (const { item, stagePath, destExists } of staged.items) {
    await fs.mkdir(dirname(item.destPath), { recursive: true });
    if (destExists) {
      const backupPath = `${item.destPath}.bak.${backupStamp()}`;
      await fs.rename(item.destPath, backupPath);
      out.backups.push(backupPath);
      await fs.rename(stagePath, item.destPath);
      out.updated.push(item.destPath);
    } else {
      await fs.rename(stagePath, item.destPath);
      out.installed.push(item.destPath);
    }
    opts.lockfile.installed[item.destPath] = lockEntry(item, opts, now);
  }

  // All staged files have been moved out by phase 4; the staging tree only
  // contains empty parent directories at this point. `force: true` makes
  // the cleanup tolerate a partial phase 4 (some entries already moved,
  // some left over).
  await fs.rm(staged.stagingRoot, { recursive: true, force: true });
  return out;
}

function lockEntry(item: PlannedFile, opts: ApplyManifestOptions, now: string): LockInstalledEntry {
  return {
    sourceUrl: opts.sourceUrl,
    sourcePath: item.sourceRelative,
    sourceSha: opts.sourceSha,
    installedAt: now,
  };
}

function backupStamp(): string {
  // Append 4 hex chars of randomness so two backups in the same millisecond
  // (e.g. parallel installs, or fast retries) don't collide on the same name.
  const ts = new Date().toISOString().replace(/:/g, '-');
  return `${ts}-${randomBytes(2).toString('hex')}`;
}
