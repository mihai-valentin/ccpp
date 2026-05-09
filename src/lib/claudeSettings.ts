import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './fsutil.js';

export interface HookCommand {
  type: 'command';
  command: string;
}

export interface SessionStartBlock {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ClaudeSettings {
  hooks?: {
    SessionStart?: SessionStartBlock[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Read `~/.claude/settings.json` (or any path passed in). Returns `null` when
 * the file doesn't exist — callers can decide whether to error or treat the
 * missing-file case as an empty settings object. Throws with a descriptive
 * message for any other read or parse failure.
 */
export async function readSettings(path: string): Promise<ClaudeSettings | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }
}

/**
 * Atomic write of `settings.json`. Uses temp + rename so a SIGINT mid-write
 * cannot leave the file truncated — Claude Code reads this file on every
 * session start, so a torn write would break every subsequent session.
 */
export async function writeSettings(path: string, settings: ClaudeSettings): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** True when a SessionStart block invokes ccpp (matched by the `ccpp` token in any of its hook commands). */
export function isCcppBlock(block: SessionStartBlock): boolean {
  return block.hooks.some((h) => h.type === 'command' && /\bccpp\b/.test(h.command));
}
