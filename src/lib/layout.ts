import { join } from 'node:path';

/**
 * Subdirectories under `~/.claude/` that ccpp manages — Claude Code's native
 * auto-discovery layout. Centralized here so a typo doesn't desync between
 * the installer's write paths, the diff's plan paths, the install-wizard's
 * tally, and the CLI's `list` classifier.
 */
export const CLAUDE_LAYOUT = {
  commands: 'commands',
  skills: 'skills',
  agents: 'agents',
} as const;

export type ResourceKind = keyof typeof CLAUDE_LAYOUT;

export interface ClaudeDirs {
  commandsDir: string;
  skillsDir: string;
  agentsDir: string;
}

/** Resolve the three managed subdirs under a given Claude home root. */
export function claudeDirs(claudeHome: string): ClaudeDirs {
  return {
    commandsDir: join(claudeHome, CLAUDE_LAYOUT.commands),
    skillsDir: join(claudeHome, CLAUDE_LAYOUT.skills),
    agentsDir: join(claudeHome, CLAUDE_LAYOUT.agents),
  };
}

/**
 * Classify a destination path under `claudeHome` as a command, skill, or
 * agent. Returns `null` for paths that don't match any of the managed dirs
 * (e.g. settings.json or untracked sub-directories).
 */
export function classifyDestination(
  destPath: string,
  claudeHome: string,
): { kind: ResourceKind; name: string } | null {
  const dirs = claudeDirs(claudeHome);
  const commandsPrefix = `${dirs.commandsDir}/`;
  const skillsPrefix = `${dirs.skillsDir}/`;
  const agentsPrefix = `${dirs.agentsDir}/`;
  if (destPath.startsWith(commandsPrefix)) {
    const name = destPath.slice(commandsPrefix.length).replace(/\.md$/, '');
    return { kind: 'commands', name };
  }
  if (destPath.startsWith(agentsPrefix)) {
    const name = destPath.slice(agentsPrefix.length).replace(/\.md$/, '');
    return { kind: 'agents', name };
  }
  if (destPath.startsWith(skillsPrefix)) {
    // Skills are directories — first path segment under skills/ is the name.
    const name = destPath.slice(skillsPrefix.length).split(/[\\/]/)[0] ?? '';
    return { kind: 'skills', name };
  }
  return null;
}
