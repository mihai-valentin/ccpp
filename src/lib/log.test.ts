import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSyncLog, readSyncLog, type SyncLogEntry } from './log.js';

let scratch: string;
let logPath: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-log-'));
  logPath = join(scratch, 'sync.log');
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

function entry(overrides: Partial<SyncLogEntry> = {}): SyncLogEntry {
  return {
    timestamp: '2026-04-23T12:00:00Z',
    trigger: 'manual',
    outcome: 'success',
    sourceUrl: 'https://example.com/repo.git',
    changeset: { added: 0, modified: 0, removed: 0 },
    ...overrides,
  };
}

describe('appendSyncLog + readSyncLog', () => {
  it('returns [] for a missing log file', async () => {
    expect(await readSyncLog(undefined, logPath)).toEqual([]);
  });

  it('round-trips entries as NDJSON', async () => {
    await appendSyncLog(entry({ outcome: 'success' }), logPath);
    await appendSyncLog(entry({ outcome: 'skipped' }), logPath);
    const raw = await fs.readFile(logPath, 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);

    const read = await readSyncLog(undefined, logPath);
    expect(read).toHaveLength(2);
    expect(read[0]!.outcome).toBe('success');
    expect(read[1]!.outcome).toBe('skipped');
  });

  it('creates the directory lazily on first append', async () => {
    const nested = join(scratch, 'deep', 'nested', 'sync.log');
    await appendSyncLog(entry(), nested);
    expect(await readSyncLog(undefined, nested)).toHaveLength(1);
  });

  it('honours the limit argument and returns the tail', async () => {
    for (let i = 0; i < 10; i++) {
      await appendSyncLog(entry({ timestamp: `2026-04-23T12:00:${String(i).padStart(2, '0')}Z` }), logPath);
    }
    const last3 = await readSyncLog(3, logPath);
    expect(last3).toHaveLength(3);
    expect(last3[0]!.timestamp).toBe('2026-04-23T12:00:07Z');
    expect(last3[2]!.timestamp).toBe('2026-04-23T12:00:09Z');
  });

  it('skips malformed lines silently', async () => {
    await fs.writeFile(
      logPath,
      `${JSON.stringify(entry())}\nnot-json\n${JSON.stringify(entry({ outcome: 'error', error: 'boom' }))}\n`,
    );
    const read = await readSyncLog(undefined, logPath);
    expect(read).toHaveLength(2);
    expect(read[1]!.outcome).toBe('error');
  });

  it('rotates when the file grows past ~1MB — trims to last 500 entries', async () => {
    // Seed the log over 1MB so the next append crosses the threshold.
    const padding = 'x'.repeat(3000);
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(
        JSON.stringify(entry({ timestamp: `seed-${i}`, error: padding, outcome: 'error' })),
      );
    }
    await fs.writeFile(logPath, `${lines.join('\n')}\n`);
    const sizeBefore = (await fs.stat(logPath)).size;
    expect(sizeBefore).toBeGreaterThan(1_000_000);

    // Append the trigger entry — this call crosses the threshold and rotates.
    await appendSyncLog(entry({ timestamp: 'trigger', outcome: 'success' }), logPath);

    const after = await readSyncLog(undefined, logPath);
    expect(after.length).toBeLessThanOrEqual(500);
    // Tail preserved — the trigger entry is the most recent.
    expect(after[after.length - 1]!.timestamp).toBe('trigger');
    // Head trimmed — 'seed-0' is long gone.
    expect(after.some((e) => e.timestamp === 'seed-0')).toBe(false);
  });

  it('swallows append errors rather than propagating them', async () => {
    // Point logPath at a location that can't be created (existing file as parent dir).
    const blocker = join(scratch, 'blocker');
    await fs.writeFile(blocker, 'file, not directory');
    const bad = join(blocker, 'sync.log');
    await expect(appendSyncLog(entry(), bad)).resolves.toBeUndefined();
  });
});
