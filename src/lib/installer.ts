import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathExists, readFileSafe } from './fsutil.js';
import { CLAUDE_LAYOUT } from './layout.js';
import type {
  Agent,
  Conflict,
  LockInstalledEntry,
  Lockfile,
  PluginManifest,
  ResolvedManifest,
  Skill,
  SlashCommand,
} from './types.js';

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
  name: string;
  claudeHome: string;
  lockfile: Lockfile;
}

export interface RemoveFromLockfileResult {
  removed: string[];
  backups: string[];
}

interface PlannedFile {
  /** Short name used for collision-lookup (command, skill, or agent). */
  name: string;
  /** Absolute path on disk of the source file. */
  sourceAbsolute: string;
  /** Path of the file relative to the source repo root. */
  sourceRelative: string;
  /** Absolute destination path under claudeHome. */
  destPath: string;
}

/**
 * Apply a parsed manifest to `<claudeHome>/` — write commands, skills, agents,
 * and lockfile entries. Non-destructive on conflict: returns a {@link Conflict}
 * list the caller surfaces to the user. Always backs up an existing file
 * whose bytes differ from what is about to be written.
 *
 * Atomicity: writes go through a two-phase staging tree. **Phase 1** reads
 * source bytes, classifies each plan item (skip / unchanged / write), and
 * stages every byte to write under `<claudeHome>/.ccpp-staging-<id>/`. If
 * any read or staging write fails, the whole staging tree is removed and
 * `~/.claude/` is left untouched. **Phase 2** renames each staged file into
 * place, backing up any pre-existing differing target to `.bak.<timestamp>`.
 *
 * Phase 2 is best-effort atomic per file (single `fs.rename` on the same
 * filesystem) but not cross-file transactional — a phase-2 failure midway
 * leaves earlier swaps committed. This is rare in practice (renames within
 * one filesystem rarely fail once the parent dir exists) and the user still
 * has the `.bak` files plus the staging tree (NOT cleaned on phase-2 failure)
 * for manual recovery.
 *
 * The in-memory `lockfile` is mutated as files commit in phase 2 — entries
 * for unchanged-but-tracked files are recorded in phase 1.
 */
export async function applyManifest(opts: ApplyManifestOptions): Promise<ApplyManifestResult> {
  const plan = planFiles(opts);
  const result: ApplyManifestResult = {
    installed: [],
    updated: [],
    unchanged: [],
    conflicts: [],
    backups: [],
  };

  const now = new Date().toISOString();

  // Phase 1 — classify and stage. `toCommit` is the sequence of files we
  // need to swap into place in phase 2 (skipping conflicts and unchanged
  // files, both of which need no on-disk write).
  type StagedWrite = { item: PlannedFile; stagePath: string; destExists: boolean };
  const toCommit: StagedWrite[] = [];

  const stagingId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const stagingRoot = join(opts.claudeHome, `.ccpp-staging-${stagingId}`);

  try {
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

      // Stage path mirrors the dest path under claudeHome so the eventual
      // rename is on the same filesystem (cheap and atomic).
      const rel = relative(opts.claudeHome, item.destPath);
      const stagePath = join(stagingRoot, rel);
      await fs.mkdir(dirname(stagePath), { recursive: true });
      await fs.writeFile(stagePath, sourceBytes);
      toCommit.push({ item, stagePath, destExists });
    }
  } catch (err) {
    // Phase 1 failed — staging tree is the only side effect; clean it up so
    // ~/.claude/ stays exactly as we found it.
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw err;
  }

  if (toCommit.length === 0) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    return result;
  }

  // Phase 2 — swap each staged file into place. On the same filesystem this
  // is an atomic rename per file; cross-file atomicity is best-effort.
  for (const { item, stagePath, destExists } of toCommit) {
    await fs.mkdir(dirname(item.destPath), { recursive: true });
    if (destExists) {
      const backupPath = `${item.destPath}.bak.${backupStamp()}`;
      await fs.rename(item.destPath, backupPath);
      result.backups.push(backupPath);
      await fs.rename(stagePath, item.destPath);
      result.updated.push(item.destPath);
    } else {
      await fs.rename(stagePath, item.destPath);
      result.installed.push(item.destPath);
    }
    opts.lockfile.installed[item.destPath] = lockEntry(item, opts, now);
  }

  // All staged files have been moved out by phase 2; the staging tree only
  // contains empty parent directories at this point. `force: true` makes
  // the cleanup tolerate a partial phase 2 (some entries already moved,
  // some left over).
  await fs.rm(stagingRoot, { recursive: true, force: true });

  return result;
}

/**
 * Remove every file installed from the given source and delete its lockfile
 * entries. Files that still exist on disk are renamed to `<path>.bak.<ts>`
 * rather than deleted outright, so recovery is always possible.
 */
export async function removeFromLockfile(
  opts: RemoveFromLockfileOptions,
): Promise<RemoveFromLockfileResult> {
  const target = opts.name;
  const toRemove: string[] = [];
  for (const [destPath, entry] of Object.entries(opts.lockfile.installed)) {
    if (entry.sourceUrl === target) toRemove.push(destPath);
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
  delete opts.lockfile.sources[target];

  return { removed, backups };
}

function planFiles(opts: ApplyManifestOptions): PlannedFile[] {
  const items: PlannedFile[] = [];
  const seenDests = new Set<string>();

  for (const cmd of opts.manifest.standaloneCommands) {
    pushCommand(items, seenDests, opts, cmd);
  }
  for (const skill of opts.manifest.standaloneSkills) {
    pushSkill(items, seenDests, opts, skill);
  }
  for (const agent of opts.manifest.standaloneAgents) {
    pushAgent(items, seenDests, opts, agent);
  }
  for (const plugin of opts.manifest.plugins) {
    pushPluginContents(items, seenDests, opts, plugin);
  }
  return items;
}

function pushCommand(
  items: PlannedFile[],
  seenDests: Set<string>,
  opts: ApplyManifestOptions,
  cmd: SlashCommand,
): void {
  const destPath = join(opts.claudeHome, CLAUDE_LAYOUT.commands, `${cmd.name}.md`);
  if (seenDests.has(destPath)) return;
  seenDests.add(destPath);
  items.push({
    name: cmd.name,
    sourceAbsolute: cmd.sourceFile,
    sourceRelative: relative(opts.manifest.sourceDir, cmd.sourceFile),
    destPath,
  });
}

function pushPluginContents(
  items: PlannedFile[],
  seenDests: Set<string>,
  opts: ApplyManifestOptions,
  plugin: PluginManifest,
): void {
  for (const cmd of plugin.commands) {
    pushCommand(items, seenDests, opts, cmd);
  }
  for (const skill of plugin.skills) {
    pushSkill(items, seenDests, opts, skill);
  }
  for (const agent of plugin.agents) {
    pushAgent(items, seenDests, opts, agent);
  }
}

function pushAgent(
  items: PlannedFile[],
  seenDests: Set<string>,
  opts: ApplyManifestOptions,
  agent: Agent,
): void {
  const destPath = join(opts.claudeHome, CLAUDE_LAYOUT.agents, `${agent.name}.md`);
  if (seenDests.has(destPath)) return;
  seenDests.add(destPath);
  items.push({
    name: agent.name,
    sourceAbsolute: agent.sourceFile,
    sourceRelative: relative(opts.manifest.sourceDir, agent.sourceFile),
    destPath,
  });
}

function pushSkill(
  items: PlannedFile[],
  seenDests: Set<string>,
  opts: ApplyManifestOptions,
  skill: Skill,
): void {
  const destRoot = join(opts.claudeHome, CLAUDE_LAYOUT.skills, skill.name);
  for (const file of skill.files) {
    const rel = relative(skill.sourceDir, file);
    const destPath = join(destRoot, rel);
    if (seenDests.has(destPath)) continue;
    seenDests.add(destPath);
    items.push({
      name: skill.name,
      sourceAbsolute: file,
      sourceRelative: relative(opts.manifest.sourceDir, file),
      destPath,
    });
  }
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
  return new Date().toISOString().replace(/:/g, '-');
}
