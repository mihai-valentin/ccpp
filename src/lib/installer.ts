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
 * Atomicity: this function is **not transactional**. A mid-loop write failure
 * leaves files already written on disk and the in-memory `lockfile` mutated up
 * to the failure point — the caller is responsible for deciding whether to
 * persist the partial lockfile. Recovery uses the `.bak.<timestamp>` files in
 * `result.backups`: any pre-existing file that would have been overwritten was
 * renamed (not deleted), so the user can restore it manually.
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

  for (const item of plan) {
    const existingEntry = opts.lockfile.installed[item.destPath];
    if (existingEntry && existingEntry.sourceUrl !== opts.sourceUrl) {
      const preferred = opts.preferredSources?.[item.name];
      if (preferred === opts.sourceUrl) {
        // Incoming source explicitly preferred → overwrite.
      } else if (preferred === existingEntry.sourceUrl) {
        // Existing source explicitly preferred → silently skip the incoming file.
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

    await fs.mkdir(dirname(item.destPath), { recursive: true });
    // readFileSafe refuses to follow symlinks — source repos are
    // partially-trusted input and a symlink could redirect the read to
    // anything on the filesystem, including files Claude Code shouldn't see.
    const sourceBytes = await readFileSafe(item.sourceAbsolute);
    const destExists = await pathExists(item.destPath);

    if (destExists) {
      const destBytes = await fs.readFile(item.destPath);
      if (buffersEqual(sourceBytes, destBytes)) {
        result.unchanged.push(item.destPath);
        opts.lockfile.installed[item.destPath] = lockEntry(item, opts, now);
        continue;
      }
      const backupPath = `${item.destPath}.bak.${backupStamp()}`;
      await fs.rename(item.destPath, backupPath);
      result.backups.push(backupPath);
      await fs.writeFile(item.destPath, sourceBytes);
      result.updated.push(item.destPath);
    } else {
      await fs.writeFile(item.destPath, sourceBytes);
      result.installed.push(item.destPath);
    }
    opts.lockfile.installed[item.destPath] = lockEntry(item, opts, now);
  }

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

function buffersEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}
