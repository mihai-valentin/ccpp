import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { pathExists, readFileSafe } from './fsutil.js';
import { CLAUDE_LAYOUT } from './layout.js';
import type {
  Agent,
  Lockfile,
  PluginManifest,
  ResolvedManifest,
  Skill,
  SlashCommand,
} from './types.js';

/**
 * Dry-run diff of what an `applyManifest` invocation would do for a single
 * source, given the current filesystem state and lockfile. Collision / preferredSources
 * filtering is deliberately out of scope — applyManifest handles that at write time;
 * callers prompt the user off the raw proposal.
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

interface PlannedFile {
  name: string;
  sourceAbsolute: string;
  destPath: string;
}

export async function computeChangeset(opts: ComputeChangesetOptions): Promise<Changeset> {
  const plan = planFiles(opts);
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

// -------- path resolution (parallel to installer.planFiles) --------
// installer.ts is intentionally closed for modification in this task; replicate
// the destPath-derivation rules here so the diff matches applyManifest exactly.

function planFiles(opts: ComputeChangesetOptions): PlannedFile[] {
  const items: PlannedFile[] = [];
  // Dedup destinations across resource kinds — e.g. a standalone agent and a
  // plugin-scoped agent could both target ~/.claude/agents/<name>.md. The
  // first pusher wins; later writers are silently dropped from the plan.
  const seenDests = new Set<string>();
  for (const cmd of opts.manifest.standaloneCommands) {
    pushCommand(items, seenDests, opts.claudeHome, cmd);
  }
  for (const skill of opts.manifest.standaloneSkills) {
    pushSkill(items, seenDests, opts.claudeHome, skill);
  }
  for (const agent of opts.manifest.standaloneAgents) {
    pushAgent(items, seenDests, opts.claudeHome, agent);
  }
  for (const plugin of opts.manifest.plugins) {
    pushPluginContents(items, seenDests, opts.claudeHome, plugin);
  }
  return items;
}

function pushCommand(
  items: PlannedFile[],
  seenDests: Set<string>,
  claudeHome: string,
  cmd: SlashCommand,
): void {
  const destPath = join(claudeHome, CLAUDE_LAYOUT.commands, `${cmd.name}.md`);
  if (seenDests.has(destPath)) return;
  seenDests.add(destPath);
  items.push({ name: cmd.name, sourceAbsolute: cmd.sourceFile, destPath });
}

function pushPluginContents(
  items: PlannedFile[],
  seenDests: Set<string>,
  claudeHome: string,
  plugin: PluginManifest,
): void {
  for (const cmd of plugin.commands) pushCommand(items, seenDests, claudeHome, cmd);
  for (const skill of plugin.skills) pushSkill(items, seenDests, claudeHome, skill);
  for (const agent of plugin.agents) pushAgent(items, seenDests, claudeHome, agent);
}

function pushAgent(
  items: PlannedFile[],
  seenDests: Set<string>,
  claudeHome: string,
  agent: Agent,
): void {
  const destPath = join(claudeHome, CLAUDE_LAYOUT.agents, `${agent.name}.md`);
  if (seenDests.has(destPath)) return;
  seenDests.add(destPath);
  items.push({ name: agent.name, sourceAbsolute: agent.sourceFile, destPath });
}

function pushSkill(
  items: PlannedFile[],
  seenDests: Set<string>,
  claudeHome: string,
  skill: Skill,
): void {
  const destRoot = join(claudeHome, CLAUDE_LAYOUT.skills, skill.name);
  for (const file of skill.files) {
    const rel = relative(skill.sourceDir, file);
    const destPath = join(destRoot, rel);
    if (seenDests.has(destPath)) continue;
    seenDests.add(destPath);
    items.push({ name: skill.name, sourceAbsolute: file, destPath });
  }
}
