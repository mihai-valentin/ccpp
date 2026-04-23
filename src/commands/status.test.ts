import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, type CcppConfig } from '../lib/config.js';
import { LOCKFILE_FILENAME } from '../lib/lockfile.js';
import { type SyncLogEntry, appendSyncLog } from '../lib/log.js';
import type { Lockfile } from '../lib/types.js';
import { runStatus } from './status.js';

let scratch: string;
let configPath: string;
let lockfilePath: string;
let logPath: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-status-'));
  configPath = join(scratch, CONFIG_FILENAME);
  lockfilePath = join(scratch, LOCKFILE_FILENAME);
  logPath = join(scratch, 'sync.log');
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function writeConfig(config: CcppConfig): Promise<void> {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function writeLock(lock: Lockfile): Promise<void> {
  await fs.writeFile(lockfilePath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

describe('runStatus', () => {
  it('errors when ccpp.config.json is missing', async () => {
    await expect(
      runStatus({ configPath, lockfilePath, logPath, json: true, quiet: true }),
    ).rejects.toThrow(/ccpp\.config\.json/i);
  });

  it('emits an empty report when config has no sources and no log', async () => {
    await writeConfig({ version: 1, scope: 'user', sources: [] });
    const report = await runStatus({ configPath, lockfilePath, logPath, json: true, quiet: true });
    expect(report.sources).toEqual([]);
    expect(report.recent).toEqual([]);
  });

  it('classifies a source with no lockfile entry as never-synced', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      sources: [{ url: 'https://example.com/a.git' }],
    });
    const report = await runStatus({ configPath, lockfilePath, logPath, json: true, quiet: true });
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]!.status).toBe('never-synced');
    expect(report.sources[0]!.policy).toBe('pinned');
  });

  it('surfaces lockfile sha + last-sync and most recent log outcome', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      syncPolicy: 'latest',
      sources: [{ url: 'https://example.com/a.git' }],
    });
    await writeLock({
      version: 1,
      sources: {
        'https://example.com/a.git': {
          sha: 'abcdef1234567',
          ref: 'main',
          lastSync: '2026-04-23T10:00:00Z',
        },
      },
      installed: {},
    });
    const entry: SyncLogEntry = {
      timestamp: '2026-04-23T10:00:00Z',
      trigger: 'hook',
      outcome: 'success',
      sourceUrl: 'https://example.com/a.git',
      changeset: { added: 1, modified: 0, removed: 0 },
    };
    await appendSyncLog(entry, logPath);

    const report = await runStatus({
      configPath,
      lockfilePath,
      logPath,
      json: true,
      quiet: true,
    });
    expect(report.sources[0]!.status).toBe('up-to-date');
    expect(report.sources[0]!.sha).toBe('abcdef1234567');
    expect(report.sources[0]!.lastSync).toBe('2026-04-23T10:00:00Z');
    expect(report.sources[0]!.policy).toBe('latest');
    expect(report.recent).toHaveLength(1);
  });

  it('reports skipped / error statuses from the most recent log entry', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      sources: [{ url: 'https://example.com/skip.git' }, { url: 'https://example.com/fail.git' }],
    });
    await writeLock({
      version: 1,
      sources: {
        'https://example.com/skip.git': { sha: 'a', ref: 'main', lastSync: 't' },
        'https://example.com/fail.git': { sha: 'b', ref: 'main', lastSync: 't' },
      },
      installed: {},
    });
    await appendSyncLog(
      {
        timestamp: 't1',
        trigger: 'hook',
        outcome: 'skipped',
        sourceUrl: 'https://example.com/skip.git',
        changeset: { added: 1, modified: 0, removed: 0 },
      },
      logPath,
    );
    await appendSyncLog(
      {
        timestamp: 't2',
        trigger: 'manual',
        outcome: 'error',
        sourceUrl: 'https://example.com/fail.git',
        error: 'git fetch failed',
      },
      logPath,
    );

    const report = await runStatus({
      configPath,
      lockfilePath,
      logPath,
      json: true,
      quiet: true,
    });
    const byUrl = Object.fromEntries(report.sources.map((s) => [s.url, s]));
    expect(byUrl['https://example.com/skip.git']!.status).toBe('skipped');
    expect(byUrl['https://example.com/fail.git']!.status).toBe('error');
    expect(byUrl['https://example.com/fail.git']!.detail).toContain('git fetch failed');
  });

  it('--json emits a single line of valid JSON with sources + recent arrays', async () => {
    await writeConfig({ version: 1, scope: 'user', sources: [] });

    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      captured += s;
      return true;
    };
    try {
      await runStatus({ configPath, lockfilePath, logPath, json: true, quiet: false });
    } finally {
      (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
    }

    expect(captured.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(captured);
    expect(parsed).toEqual({ sources: [], recent: [] });
  });

  it('respects recentLimit for the tail of events', async () => {
    await writeConfig({ version: 1, scope: 'user', sources: [] });
    for (let i = 0; i < 10; i++) {
      await appendSyncLog(
        {
          timestamp: `t${i}`,
          trigger: 'manual',
          outcome: 'success',
          changeset: { added: 0, modified: 0, removed: 0 },
        },
        logPath,
      );
    }
    const report = await runStatus({
      configPath,
      lockfilePath,
      logPath,
      json: true,
      quiet: true,
      recentLimit: 3,
    });
    expect(report.recent).toHaveLength(3);
    expect(report.recent[2]!.timestamp).toBe('t9');
  });
});
