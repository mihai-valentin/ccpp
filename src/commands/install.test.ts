import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalGitFixture } from '../../tests/helpers/local-git-fixture.js';
import { emptyConfig } from '../lib/config.js';
import { CollisionError } from '../lib/errors.js';
import { type InstallSourceParams, installSource } from './install.js';

let scratch: string;
let claudeHome: string;
let cacheRoot: string;
let configPath: string;
let lockfilePath: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-install-direct-'));
  claudeHome = join(scratch, 'claude');
  cacheRoot = join(scratch, 'cache');
  configPath = join(scratch, 'ccpp.config.json');
  lockfilePath = join(scratch, 'ccpp.lock.json');
  process.env.CCPP_CACHE = cacheRoot;
});

afterEach(async () => {
  delete process.env.CCPP_CACHE;
  await fs.rm(scratch, { recursive: true, force: true });
});

function commonForTest() {
  return { claudeHome, configPath, lockfilePath, json: false, quiet: true };
}

describe('installSource — collision retry path', () => {
  it('forcePreferIncoming=true retries with incoming source winning the conflict', async () => {
    // Two sources publish the same standalone command. Install A first
    // (clean), then install B with forcePreferIncoming — the second pass
    // should report `updated: ['…/overlap.md']` after the retry.
    const a = await createLocalGitFixture('ccpp-direct-A');
    const b = await createLocalGitFixture('ccpp-direct-B');
    try {
      await fs.mkdir(join(a.workPath, 'commands'), { recursive: true });
      await fs.mkdir(join(b.workPath, 'commands'), { recursive: true });
      await a.advance('commands/overlap.md', 'A');
      await b.advance('commands/overlap.md', 'B');

      const baseConfig = emptyConfig();
      const first: InstallSourceParams = {
        url: a.url,
        common: commonForTest(),
        existing: baseConfig,
        scratch: false,
        forcePreferIncoming: false,
      };
      const firstOut = await installSource(first);
      expect(firstOut.result.installed).toHaveLength(1);

      const second: InstallSourceParams = {
        url: b.url,
        common: commonForTest(),
        existing: firstOut.config,
        scratch: false,
        forcePreferIncoming: true,
      };
      const secondOut = await installSource(second);

      // The retry produced a write — the destination now matches B.
      const merged = [...secondOut.result.installed, ...secondOut.result.updated];
      expect(merged).toEqual([join(claudeHome, 'commands', 'overlap.md')]);
      expect(secondOut.result.conflicts).toEqual([]);
      const bytes = await fs.readFile(join(claudeHome, 'commands', 'overlap.md'), 'utf8');
      expect(bytes).toBe('B');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 30_000);

  it('throws CollisionError when no resolveConflicts handler is supplied', async () => {
    // No forcePreferIncoming, no resolveConflicts → fall through to the
    // explicit collision throw. Lockfile is still persisted so the source
    // pin from before the throw is recorded.
    const a = await createLocalGitFixture('ccpp-direct-noresolver-A');
    const b = await createLocalGitFixture('ccpp-direct-noresolver-B');
    try {
      await fs.mkdir(join(a.workPath, 'commands'), { recursive: true });
      await fs.mkdir(join(b.workPath, 'commands'), { recursive: true });
      await a.advance('commands/overlap.md', 'A');
      await b.advance('commands/overlap.md', 'B');

      const baseConfig = emptyConfig();
      await installSource({
        url: a.url,
        common: commonForTest(),
        existing: baseConfig,
        scratch: false,
        forcePreferIncoming: false,
      });

      await expect(
        installSource({
          url: b.url,
          common: commonForTest(),
          existing: baseConfig,
          scratch: false,
          forcePreferIncoming: false,
        }),
      ).rejects.toBeInstanceOf(CollisionError);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 30_000);

  it('resolveConflicts callback can pick the incoming source — retry applies', async () => {
    const a = await createLocalGitFixture('ccpp-direct-resolver-A');
    const b = await createLocalGitFixture('ccpp-direct-resolver-B');
    try {
      await fs.mkdir(join(a.workPath, 'commands'), { recursive: true });
      await fs.mkdir(join(b.workPath, 'commands'), { recursive: true });
      await a.advance('commands/overlap.md', 'A');
      await b.advance('commands/overlap.md', 'B');

      const baseConfig = emptyConfig();
      await installSource({
        url: a.url,
        common: commonForTest(),
        existing: baseConfig,
        scratch: false,
        forcePreferIncoming: false,
      });

      let resolverCalled = false;
      const out = await installSource({
        url: b.url,
        common: commonForTest(),
        existing: baseConfig,
        scratch: false,
        forcePreferIncoming: false,
        resolveConflicts: async (conflicts, incoming) => {
          resolverCalled = true;
          // Pick incoming for every conflict
          const picked: Record<string, string> = {};
          for (const c of conflicts) picked[c.name] = incoming;
          return picked;
        },
      });

      expect(resolverCalled).toBe(true);
      expect(out.result.conflicts).toEqual([]);
      const bytes = await fs.readFile(join(claudeHome, 'commands', 'overlap.md'), 'utf8');
      expect(bytes).toBe('B');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 30_000);

  it('resolveConflicts returning null aborts the install with CollisionError', async () => {
    const a = await createLocalGitFixture('ccpp-direct-abort-A');
    const b = await createLocalGitFixture('ccpp-direct-abort-B');
    try {
      await fs.mkdir(join(a.workPath, 'commands'), { recursive: true });
      await fs.mkdir(join(b.workPath, 'commands'), { recursive: true });
      await a.advance('commands/overlap.md', 'A');
      await b.advance('commands/overlap.md', 'B');

      const baseConfig = emptyConfig();
      await installSource({
        url: a.url,
        common: commonForTest(),
        existing: baseConfig,
        scratch: false,
        forcePreferIncoming: false,
      });

      await expect(
        installSource({
          url: b.url,
          common: commonForTest(),
          existing: baseConfig,
          scratch: false,
          forcePreferIncoming: false,
          resolveConflicts: async () => null, // user said cancel
        }),
      ).rejects.toBeInstanceOf(CollisionError);

      // Existing source's bytes are untouched.
      const bytes = await fs.readFile(join(claudeHome, 'commands', 'overlap.md'), 'utf8');
      expect(bytes).toBe('A');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 30_000);
});
