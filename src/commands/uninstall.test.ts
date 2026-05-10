import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeLockfile } from '../lib/lockfile.js';
import type { Lockfile } from '../lib/types.js';
import { runUninstall } from './uninstall.js';

let scratch: string;
let claudeHome: string;
let configPath: string;
let lockfilePath: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-uninstall-'));
  claudeHome = join(scratch, 'claude');
  configPath = join(scratch, 'ccpp.config.json');
  lockfilePath = join(scratch, 'ccpp.lock.json');
  await fs.mkdir(claudeHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

function commonForTest() {
  return { claudeHome, configPath, lockfilePath, json: true, quiet: false };
}

async function seedLockfile(
  sourceUrl: string,
  destPaths: string[],
  ondisk: Set<string>,
): Promise<void> {
  const lockfile: Lockfile = {
    version: 1,
    sources: {
      [sourceUrl]: { sha: 'a'.repeat(40), ref: 'main', lastSync: '2026-05-10T00:00:00.000Z' },
    },
    installed: {},
  };
  for (const dest of destPaths) {
    lockfile.installed[dest] = {
      sourceUrl,
      sourcePath: 'commands/x.md',
      sourceSha: 'a'.repeat(40),
      installedAt: '2026-05-10T00:00:00.000Z',
    };
    if (ondisk.has(dest)) {
      await fs.mkdir(join(dest, '..'), { recursive: true });
      await fs.writeFile(dest, `content of ${dest}`);
    }
  }
  await writeLockfile(lockfilePath, lockfile);
}

describe('runUninstall — JSON output reports missing separately', () => {
  it('splits removed entries into backups (file existed) and missing (file gone)', async () => {
    const sourceUrl = 'file:///tmp/ccpp-int-stale/foo.git';
    const live = join(claudeHome, 'commands', 'live.md');
    const stale = join(claudeHome, 'commands', 'stale.md');
    await seedLockfile(sourceUrl, [live, stale], new Set([live]));

    const captured: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      captured.push(typeof c === 'string' ? c : c.toString('utf8'));
      return true;
    });
    try {
      await runUninstall({ ...commonForTest(), name: sourceUrl });
    } finally {
      writeSpy.mockRestore();
    }

    const jsonLine = captured.find((l) => l.trim().startsWith('{'));
    expect(jsonLine, `expected JSON output, got: ${JSON.stringify(captured)}`).toBeDefined();
    const out = JSON.parse((jsonLine as string).trim());
    expect(out.source).toBe(sourceUrl);
    expect(out.removed).toHaveLength(2);
    expect(out.backups).toHaveLength(1);
    expect(out.missing).toHaveLength(1);
    expect(out.missing).toContain(stale);
    expect(out.backups[0]).toMatch(/live\.md\.bak\./);
    // The disk file that existed should now be gone (renamed to .bak).
    await expect(fs.access(live)).rejects.toThrow();
    // The dest that was never on disk stays absent.
    await expect(fs.access(stale)).rejects.toThrow();
  });

  it('reports missing=[] when every dest existed on disk', async () => {
    const sourceUrl = 'file:///tmp/ccpp-int-clean/foo.git';
    const a = join(claudeHome, 'commands', 'a.md');
    const b = join(claudeHome, 'commands', 'b.md');
    await seedLockfile(sourceUrl, [a, b], new Set([a, b]));

    const captured: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      captured.push(typeof c === 'string' ? c : c.toString('utf8'));
      return true;
    });
    try {
      await runUninstall({ ...commonForTest(), name: sourceUrl });
    } finally {
      writeSpy.mockRestore();
    }

    const jsonLine = captured.find((l) => l.trim().startsWith('{'));
    expect(jsonLine, `expected JSON output, got: ${JSON.stringify(captured)}`).toBeDefined();
    const out = JSON.parse((jsonLine as string).trim());
    expect(out.removed).toHaveLength(2);
    expect(out.backups).toHaveLength(2);
    expect(out.missing).toHaveLength(0);
  });
});
