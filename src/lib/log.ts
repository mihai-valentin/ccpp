import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type SyncTrigger = 'manual' | 'hook';
export type SyncOutcome = 'success' | 'skipped' | 'error';

export interface SyncLogEntry {
  /** ISO 8601 UTC timestamp of the event. */
  timestamp: string;
  /** What triggered this sync — a user invocation or the SessionStart hook. */
  trigger: SyncTrigger;
  /** Coarse verdict: applied cleanly, skipped (e.g. non-TTY / user declined), or errored. */
  outcome: SyncOutcome;
  /** Source URL this entry is about. Omitted for top-level events without a source. */
  sourceUrl?: string;
  /** Count summary of the diff; present on success/skipped outcomes. */
  changeset?: { added: number; modified: number; removed: number };
  /** Human-readable error message on outcome=error. */
  error?: string;
}

/**
 * Default log file path. `${CCPP_HOME:-~/.ccpp}/sync.log`.
 * Kept as a function so tests (and the hook script) can override via env.
 */
export function defaultLogPath(): string {
  const ccppHome = process.env.CCPP_HOME;
  if (ccppHome && ccppHome.length > 0) return join(ccppHome, 'sync.log');
  return join(homedir(), '.ccpp', 'sync.log');
}

const MAX_BYTES = 1_000_000;
const TRIM_TO_ENTRIES = 500;

/**
 * Append one NDJSON entry to the log. Creates the directory and file if needed.
 * If the file grows past ~1MB, trims to the last {@link TRIM_TO_ENTRIES} entries
 * in place. Rotation failures are swallowed — logging must never crash the caller.
 */
export async function appendSyncLog(
  entry: SyncLogEntry,
  logPath: string = defaultLogPath(),
): Promise<void> {
  try {
    await fs.mkdir(dirname(logPath), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    await fs.appendFile(logPath, line);
    const stat = await fs.stat(logPath);
    if (stat.size > MAX_BYTES) await rotate(logPath);
  } catch {
    // Logging is best-effort; never propagate failure into sync or hook paths.
  }
}

/**
 * Read log entries (oldest → newest). If `limit` is provided, returns the last
 * `limit` entries. Missing file → []. Malformed lines are skipped silently.
 */
export async function readSyncLog(
  limit?: number,
  logPath: string = defaultLogPath(),
): Promise<SyncLogEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  const entries: SyncLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SyncLogEntry);
    } catch {
      // skip malformed line
    }
  }
  if (limit !== undefined && limit >= 0 && entries.length > limit) {
    return entries.slice(entries.length - limit);
  }
  return entries;
}

async function rotate(logPath: string): Promise<void> {
  const entries = await readSyncLog(undefined, logPath);
  const keep = entries.slice(-TRIM_TO_ENTRIES);
  const content = keep.length === 0 ? '' : `${keep.map((e) => JSON.stringify(e)).join('\n')}\n`;
  await fs.writeFile(logPath, content);
}
