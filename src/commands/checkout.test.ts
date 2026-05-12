import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalGitFixture } from '../../tests/helpers/local-git-fixture.js';
import { readConfig, writeConfig } from '../lib/config.js';
import { CollisionError, UserError } from '../lib/errors.js';
import { runCheckout } from './checkout.js';
import { installSource } from './install.js';

let scratch: string;
let claudeHome: string;
let cacheRoot: string;
let configPath: string;
let lockfilePath: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-checkout-'));
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

async function seedTwoBranchSource(label: string): Promise<{
  url: string;
  cleanup: () => Promise<void>;
}> {
  // Branches differ in the same file's contents so checkout's
  // applyManifest must actually rewrite the destination to flip them.
  const fx = await createLocalGitFixture(label);
  await fs.mkdir(join(fx.workPath, 'commands'), { recursive: true });
  await fx.advance('commands/cmd.md', 'MAIN');
  await fx.advanceOn('experimental', 'commands/cmd.md', 'EXPERIMENTAL');
  return { url: fx.url, cleanup: fx.cleanup };
}

describe('runCheckout — happy path', () => {
  it('switches an existing source from main to experimental: config, lockfile, disk all reflect the new ref', async () => {
    const { url, cleanup } = await seedTwoBranchSource('ccpp-co-happy');
    try {
      // Seed: install at main.
      const installed = await installSource({
        url,
        ref: 'main',
        common: commonForTest(),
        existing: null,
        scratch: false,
        forcePreferIncoming: false,
      });
      expect(installed.synced.ref).toBe('main');
      const cmdPath = join(claudeHome, 'commands', 'cmd.md');
      expect(await fs.readFile(cmdPath, 'utf8')).toBe('MAIN');

      // Checkout to experimental.
      await runCheckout({
        source: url,
        ref: 'experimental',
        ...commonForTest(),
      });

      // Disk reflects the new branch's bytes.
      expect(await fs.readFile(cmdPath, 'utf8')).toBe('EXPERIMENTAL');

      // Config carries the new ref on the same source entry (no duplicate).
      const config = await readConfig(configPath);
      expect(config).not.toBeNull();
      expect(config?.sources).toHaveLength(1);
      expect(config?.sources[0]?.url).toBe(url);
      expect(config?.sources[0]?.ref).toBe('experimental');

      // Lockfile pin updated.
      const lockText = await fs.readFile(lockfilePath, 'utf8');
      const lock = JSON.parse(lockText);
      expect(lock.sources[url].ref).toBe('experimental');
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('round-trips: experimental → back to main restores main bytes', async () => {
    const { url, cleanup } = await seedTwoBranchSource('ccpp-co-roundtrip');
    try {
      await installSource({
        url,
        ref: 'main',
        common: commonForTest(),
        existing: null,
        scratch: false,
        forcePreferIncoming: false,
      });
      await runCheckout({ source: url, ref: 'experimental', ...commonForTest() });
      await runCheckout({ source: url, ref: 'main', ...commonForTest() });

      const cmdPath = join(claudeHome, 'commands', 'cmd.md');
      expect(await fs.readFile(cmdPath, 'utf8')).toBe('MAIN');
      const config = await readConfig(configPath);
      expect(config?.sources[0]?.ref).toBe('main');
    } finally {
      await cleanup();
    }
  }, 45_000);
});

describe('runCheckout — guard rails', () => {
  it('errors when the source is not in ccpp.config.json', async () => {
    // No config at all → UserError pointing at install.
    await expect(
      runCheckout({
        source: 'file:///nonexistent.git',
        ref: 'main',
        ...commonForTest(),
      }),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('errors when the named source is missing from a present config', async () => {
    // Config exists but doesn't list the URL the user asked to check out.
    await writeConfig(configPath, {
      version: 1,
      sources: [{ url: 'file:///other.git', ref: 'main' }],
    });
    await expect(
      runCheckout({
        source: 'file:///nonexistent.git',
        ref: 'main',
        ...commonForTest(),
      }),
    ).rejects.toThrow(/not in ccpp\.config\.json/);
  });

  it('rejects shorthand-vs-positional ref conflicts', async () => {
    // user typed `checkout url@main experimental` — two different refs.
    await writeConfig(configPath, {
      version: 1,
      sources: [{ url: 'file:///x.git', ref: 'main' }],
    });
    await expect(
      runCheckout({
        source: 'file:///x.git@main',
        ref: 'experimental',
        ...commonForTest(),
      }),
    ).rejects.toThrow(/ref conflict/);
  });

  it('errors when neither shorthand nor positional supplies a ref', async () => {
    await expect(
      runCheckout({
        source: 'file:///x.git',
        ...commonForTest(),
      }),
    ).rejects.toThrow(/missing <ref>/);
  });
});

describe('runCheckout — no-op same ref', () => {
  it('emits "already on <ref>" and writes nothing when the requested ref matches config', async () => {
    const { url, cleanup } = await seedTwoBranchSource('ccpp-co-noop');
    try {
      await installSource({
        url,
        ref: 'main',
        common: commonForTest(),
        existing: null,
        scratch: false,
        forcePreferIncoming: false,
      });
      // Snapshot lockfile mtime so we can assert it didn't get rewritten.
      const lockBefore = await fs.stat(lockfilePath);
      const configBefore = await fs.stat(configPath);

      // Sleep 10ms then run no-op — mtime granularity on some FSes is coarse,
      // so giving it a beat avoids a flaky equality check.
      await new Promise((r) => setTimeout(r, 10));
      await runCheckout({ source: url, ref: 'main', ...commonForTest() });

      const lockAfter = await fs.stat(lockfilePath);
      const configAfter = await fs.stat(configPath);
      expect(lockAfter.mtimeMs).toBe(lockBefore.mtimeMs);
      expect(configAfter.mtimeMs).toBe(configBefore.mtimeMs);
    } finally {
      await cleanup();
    }
  }, 30_000);
});

describe('runCheckout — dry-run', () => {
  it('emits a changeset summary without touching disk, config, or lockfile', async () => {
    const { url, cleanup } = await seedTwoBranchSource('ccpp-co-dryrun');
    try {
      await installSource({
        url,
        ref: 'main',
        common: commonForTest(),
        existing: null,
        scratch: false,
        forcePreferIncoming: false,
      });

      const cmdPath = join(claudeHome, 'commands', 'cmd.md');
      const diskBefore = await fs.readFile(cmdPath, 'utf8');
      const configBefore = await fs.readFile(configPath, 'utf8');
      const lockBefore = await fs.readFile(lockfilePath, 'utf8');

      const captured: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
        captured.push(typeof c === 'string' ? c : c.toString('utf8'));
        return true;
      });
      try {
        await runCheckout({
          source: url,
          ref: 'experimental',
          ...commonForTest(),
          json: true,
          dryRun: true,
        });
      } finally {
        writeSpy.mockRestore();
      }

      // Nothing on disk or in the persistent stores moved.
      expect(await fs.readFile(cmdPath, 'utf8')).toBe(diskBefore);
      expect(await fs.readFile(configPath, 'utf8')).toBe(configBefore);
      expect(await fs.readFile(lockfilePath, 'utf8')).toBe(lockBefore);

      // JSON output shape: dryRun: true, modified non-empty, no installed/updated.
      const jsonLine = captured.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const out = JSON.parse((jsonLine as string).trim());
      expect(out.dryRun).toBe(true);
      expect(out.fromRef).toBe('main');
      expect(out.toRef).toBe('experimental');
      expect(out.modified).toContain(cmdPath);
    } finally {
      await cleanup();
    }
  }, 30_000);
});

describe('runCheckout — JSON output', () => {
  it('emits { url, fromRef, toRef, toSha, installed, updated, ... }', async () => {
    const { url, cleanup } = await seedTwoBranchSource('ccpp-co-json');
    try {
      await installSource({
        url,
        ref: 'main',
        common: commonForTest(),
        existing: null,
        scratch: false,
        forcePreferIncoming: false,
      });

      const captured: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
        captured.push(typeof c === 'string' ? c : c.toString('utf8'));
        return true;
      });
      try {
        await runCheckout({
          source: url,
          ref: 'experimental',
          ...commonForTest(),
          json: true,
        });
      } finally {
        writeSpy.mockRestore();
      }

      const jsonLine = captured.find((l) => l.trim().startsWith('{'));
      expect(jsonLine).toBeDefined();
      const out = JSON.parse((jsonLine as string).trim());
      expect(out.url).toBe(url);
      expect(out.fromRef).toBe('main');
      expect(out.toRef).toBe('experimental');
      expect(typeof out.toSha).toBe('string');
      // One file flipped main → experimental, so the updated list is non-empty.
      expect(out.updated).toContain(join(claudeHome, 'commands', 'cmd.md'));
      expect(out.conflicts).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 30_000);
});

describe('runCheckout — collisions', () => {
  it('throws CollisionError when another source owns one of the destinations and --prefer is not set', async () => {
    // Two sources publish the same file. Install A first; then add B to
    // config (manually, simulating a user who edited config) and try to
    // check it out. The first applyManifest call will see the existing
    // entry owned by A → CollisionError without --prefer.
    const fxA = await createLocalGitFixture('ccpp-co-collide-A');
    const fxB = await createLocalGitFixture('ccpp-co-collide-B');
    try {
      await fs.mkdir(join(fxA.workPath, 'commands'), { recursive: true });
      await fs.mkdir(join(fxB.workPath, 'commands'), { recursive: true });
      await fxA.advance('commands/overlap.md', 'A');
      await fxB.advance('commands/overlap.md', 'B-main');
      await fxB.advanceOn('experimental', 'commands/overlap.md', 'B-exp');

      await installSource({
        url: fxA.url,
        ref: 'main',
        common: commonForTest(),
        existing: null,
        scratch: false,
        forcePreferIncoming: false,
      });
      // Pretend B was added to config at main (without an install, so its
      // files aren't on disk yet) and now the user wants to check it out
      // at experimental. The first applyManifest pass collides with A.
      const config = await readConfig(configPath);
      if (!config) throw new Error('expected config');
      config.sources.push({ url: fxB.url, ref: 'main' });
      await writeConfig(configPath, config);

      await expect(
        runCheckout({
          source: fxB.url,
          ref: 'experimental',
          ...commonForTest(),
        }),
      ).rejects.toBeInstanceOf(CollisionError);
    } finally {
      await fxA.cleanup();
      await fxB.cleanup();
    }
  }, 45_000);

  it('--prefer auto-resolves collisions in favour of the checkout', async () => {
    const fxA = await createLocalGitFixture('ccpp-co-prefer-A');
    const fxB = await createLocalGitFixture('ccpp-co-prefer-B');
    try {
      await fs.mkdir(join(fxA.workPath, 'commands'), { recursive: true });
      await fs.mkdir(join(fxB.workPath, 'commands'), { recursive: true });
      await fxA.advance('commands/overlap.md', 'A');
      await fxB.advance('commands/overlap.md', 'B-main');
      await fxB.advanceOn('experimental', 'commands/overlap.md', 'B-exp');

      await installSource({
        url: fxA.url,
        ref: 'main',
        common: commonForTest(),
        existing: null,
        scratch: false,
        forcePreferIncoming: false,
      });
      const config = await readConfig(configPath);
      if (!config) throw new Error('expected config');
      config.sources.push({ url: fxB.url, ref: 'main' });
      await writeConfig(configPath, config);

      await runCheckout({
        source: fxB.url,
        ref: 'experimental',
        ...commonForTest(),
        prefer: true,
      });

      // Incoming source wins — disk is now B's experimental bytes.
      const dest = join(claudeHome, 'commands', 'overlap.md');
      expect(await fs.readFile(dest, 'utf8')).toBe('B-exp');

      // Config records the conflict winner (keyed by the manifest "name" —
      // a slash-command's name is the filename without `.md`) so future
      // syncs stay consistent.
      const finalConfig = await readConfig(configPath);
      expect(finalConfig?.preferredSources?.overlap).toBe(fxB.url);
    } finally {
      await fxA.cleanup();
      await fxB.cleanup();
    }
  }, 45_000);
});
