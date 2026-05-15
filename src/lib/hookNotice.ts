import { promises as fs } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { CLAUDE_LAYOUT } from './layout.js';

/**
 * Path to the one-shot notice file the SessionStart hook reads and clears.
 * Co-located with sync.log so both honor `CCPP_HOME` the same way.
 */
export function noticeFilePath(logPath: string): string {
  return join(dirname(logPath), 'last-hook-notice.txt');
}

/**
 * Filter a flat list of absolute destPaths down to those that live under
 * `<claudeHome>/agents/`. Used to detect agent registry mutations that
 * Claude Code will not see until the next session start (CC bug #58592).
 */
export function pickAgentPaths(destPaths: string[], claudeHome: string): string[] {
  const root = join(claudeHome, CLAUDE_LAYOUT.agents) + sep;
  return destPaths.filter((p) => p.startsWith(root));
}

/** Best-effort. Failure to write the notice must never break sync. */
export async function writeHookNotice(logPath: string, message: string): Promise<void> {
  try {
    await fs.mkdir(dirname(logPath), { recursive: true });
    await fs.writeFile(noticeFilePath(logPath), `${message}\n`);
  } catch {
    /* swallow — notice is a courtesy, not a guarantee */
  }
}
