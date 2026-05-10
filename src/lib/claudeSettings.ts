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
 * message for any other read, parse, or shape-mismatch failure (e.g. a
 * hand-edited `hooks` field that isn't an object, or a `SessionStart` field
 * that isn't an array).
 */
export async function readSettings(path: string): Promise<ClaudeSettings | null> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  return validateSettings(parsed, path);
}

function validateSettings(raw: unknown, path: string): ClaudeSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid ${path}: expected a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.hooks !== undefined) {
    if (!obj.hooks || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks)) {
      throw new Error(`Invalid ${path}: "hooks" must be an object if set.`);
    }
    const hooks = obj.hooks as Record<string, unknown>;
    if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) {
      throw new Error(`Invalid ${path}: "hooks.SessionStart" must be an array if set.`);
    }
  }
  return obj as ClaudeSettings;
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
