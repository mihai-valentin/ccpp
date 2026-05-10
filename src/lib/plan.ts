import { join, relative } from 'node:path';
import { CLAUDE_LAYOUT } from './layout.js';
import type { Agent, PluginManifest, ResolvedManifest, Skill, SlashCommand } from './types.js';

/**
 * One plan-time entry — a single source file that should land at a single
 * destination under `<claudeHome>/`. Returned by {@link planFiles} and
 * consumed by both `installer.applyManifest` (for writes) and
 * `diff.computeChangeset` (for the dry-run report). Centralizing the rule
 * "manifest item → destination path" eliminates the drift risk that caused
 * the v0.2.0 agents bug, where diff.ts and installer.ts each carried their
 * own copy and only one was updated.
 */
export interface PlannedFile {
  /** Short name used for collision lookup (command, skill, or agent). */
  name: string;
  /** Absolute path on disk of the source file. */
  sourceAbsolute: string;
  /** Path of the file relative to the manifest's sourceDir (used by lockfile entries). */
  sourceRelative: string;
  /** Absolute destination path under claudeHome. */
  destPath: string;
}

/**
 * Walk a resolved manifest and produce one PlannedFile per file that should
 * land in `<claudeHome>/`. Order: standalone commands → standalone skills →
 * standalone agents → plugin commands → plugin skills → plugin agents. The
 * first writer for any given destPath wins; later writers (e.g. a plugin
 * agent that collides with a standalone agent in the same source) are
 * silently dropped from the plan — that case is caught upstream as a
 * collision warning by `manifest.parseManifest`.
 */
export function planFiles(manifest: ResolvedManifest, claudeHome: string): PlannedFile[] {
  const items: PlannedFile[] = [];
  // Dedup destinations across resource kinds — see header doc.
  const seenDests = new Set<string>();
  const ctx = { claudeHome, sourceDir: manifest.sourceDir };

  for (const cmd of manifest.standaloneCommands) {
    pushCommand(items, seenDests, ctx, cmd);
  }
  for (const skill of manifest.standaloneSkills) {
    pushSkill(items, seenDests, ctx, skill);
  }
  for (const agent of manifest.standaloneAgents) {
    pushAgent(items, seenDests, ctx, agent);
  }
  for (const plugin of manifest.plugins) {
    pushPluginContents(items, seenDests, ctx, plugin);
  }
  return items;
}

interface PlanCtx {
  claudeHome: string;
  sourceDir: string;
}

function pushCommand(
  items: PlannedFile[],
  seenDests: Set<string>,
  ctx: PlanCtx,
  cmd: SlashCommand,
): void {
  const destPath = join(ctx.claudeHome, CLAUDE_LAYOUT.commands, `${cmd.name}.md`);
  if (seenDests.has(destPath)) return;
  seenDests.add(destPath);
  items.push({
    name: cmd.name,
    sourceAbsolute: cmd.sourceFile,
    sourceRelative: relative(ctx.sourceDir, cmd.sourceFile),
    destPath,
  });
}

function pushAgent(items: PlannedFile[], seenDests: Set<string>, ctx: PlanCtx, agent: Agent): void {
  const destPath = join(ctx.claudeHome, CLAUDE_LAYOUT.agents, `${agent.name}.md`);
  if (seenDests.has(destPath)) return;
  seenDests.add(destPath);
  items.push({
    name: agent.name,
    sourceAbsolute: agent.sourceFile,
    sourceRelative: relative(ctx.sourceDir, agent.sourceFile),
    destPath,
  });
}

function pushSkill(items: PlannedFile[], seenDests: Set<string>, ctx: PlanCtx, skill: Skill): void {
  const destRoot = join(ctx.claudeHome, CLAUDE_LAYOUT.skills, skill.name);
  for (const file of skill.files) {
    const rel = relative(skill.sourceDir, file);
    const destPath = join(destRoot, rel);
    if (seenDests.has(destPath)) continue;
    seenDests.add(destPath);
    items.push({
      name: skill.name,
      sourceAbsolute: file,
      sourceRelative: relative(ctx.sourceDir, file),
      destPath,
    });
  }
}

function pushPluginContents(
  items: PlannedFile[],
  seenDests: Set<string>,
  ctx: PlanCtx,
  plugin: PluginManifest,
): void {
  for (const cmd of plugin.commands) pushCommand(items, seenDests, ctx, cmd);
  for (const skill of plugin.skills) pushSkill(items, seenDests, ctx, skill);
  for (const agent of plugin.agents) pushAgent(items, seenDests, ctx, agent);
}
