import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCKFILE_FILENAME,
  emptyLockfile,
  readLockfile,
  stableStringify,
  writeLockfile,
} from './lockfile.js';
import type { Lockfile } from './types.js';

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-lock-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('emptyLockfile', () => {
  it('returns a fresh lockfile with version 1 and empty maps', () => {
    expect(emptyLockfile()).toEqual({ version: 1, sources: {}, installed: {} });
  });
});

describe('readLockfile', () => {
  it('returns an empty lockfile when the file does not exist', async () => {
    const lock = await readLockfile(join(scratch, LOCKFILE_FILENAME));
    expect(lock).toEqual({ version: 1, sources: {}, installed: {} });
  });

  it('round-trips through writeLockfile/readLockfile', async () => {
    const path = join(scratch, LOCKFILE_FILENAME);
    const lock: Lockfile = {
      version: 1,
      sources: {
        'https://github.com/foo/bar.git': {
          sha: 'deadbeef',
          ref: 'main',
          lastSync: '2026-04-22T00:00:00.000Z',
        },
      },
      installed: {
        '/home/x/.claude/commands/hello.md': {
          sourceUrl: 'https://github.com/foo/bar.git',
          sourcePath: 'commands/hello.md',
          sourceSha: 'deadbeef',
          installedAt: '2026-04-22T00:00:00.000Z',
        },
      },
    };
    await writeLockfile(path, lock);
    const reloaded = await readLockfile(path);
    expect(reloaded).toEqual(lock);
  });

  it('rejects a lockfile with an unsupported schema version', async () => {
    const path = join(scratch, LOCKFILE_FILENAME);
    await fs.writeFile(path, JSON.stringify({ version: 99, sources: {}, installed: {} }));
    await expect(readLockfile(path)).rejects.toThrow(/Unsupported lockfile version/);
  });

  it('rejects a lockfile whose JSON is malformed', async () => {
    const path = join(scratch, LOCKFILE_FILENAME);
    await fs.writeFile(path, '{ not valid json');
    await expect(readLockfile(path)).rejects.toThrow(/Failed to parse lockfile/);
  });
});

describe('stableStringify', () => {
  it('produces byte-identical output for equivalent inputs (order-independent)', () => {
    const a: Lockfile = {
      version: 1,
      sources: {
        'https://github.com/b.git': { sha: '2', ref: 'main', lastSync: 't2' },
        'https://github.com/a.git': { sha: '1', ref: 'main', lastSync: 't1' },
      },
      installed: {
        '/b.md': {
          sourceUrl: 'https://github.com/b.git',
          sourcePath: 'b.md',
          sourceSha: '2',
          installedAt: 't2',
        },
        '/a.md': {
          sourceUrl: 'https://github.com/a.git',
          sourcePath: 'a.md',
          sourceSha: '1',
          installedAt: 't1',
        },
      },
    };
    const b: Lockfile = {
      version: 1,
      installed: {
        '/a.md': {
          sourceUrl: 'https://github.com/a.git',
          sourcePath: 'a.md',
          sourceSha: '1',
          installedAt: 't1',
        },
        '/b.md': {
          sourceUrl: 'https://github.com/b.git',
          sourcePath: 'b.md',
          sourceSha: '2',
          installedAt: 't2',
        },
      },
      sources: {
        'https://github.com/a.git': { sha: '1', ref: 'main', lastSync: 't1' },
        'https://github.com/b.git': { sha: '2', ref: 'main', lastSync: 't2' },
      },
    };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('ends with a trailing newline', () => {
    expect(stableStringify(emptyLockfile()).endsWith('\n')).toBe(true);
  });

  it('serialises the same input byte-identically on repeated calls', () => {
    const lock: Lockfile = {
      version: 1,
      sources: { 'url-1': { sha: 'x', ref: 'main', lastSync: 't' } },
      installed: {
        '/d1': { sourceUrl: 'url-1', sourcePath: 'p', sourceSha: 'x', installedAt: 't' },
      },
    };
    expect(stableStringify(lock)).toBe(stableStringify(lock));
  });
});
