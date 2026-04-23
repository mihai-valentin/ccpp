import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLocalGitFixture,
  type LocalGitFixture,
} from '../../tests/helpers/local-git-fixture.js';
import { type CcppConfig, CONFIG_FILENAME } from '../lib/config.js';
import { LOCKFILE_FILENAME } from '../lib/lockfile.js';
import { resolveOverride, runSync } from './sync.js';

let scratch: string;
let cacheRoot: string;
let claudeHome: string;
let configPath: string;
let lockfilePath: string;
let fixture: LocalGitFixture;
let prevCache: string | undefined;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-sync-'));
  cacheRoot = join(scratch, 'cache');
  claudeHome = join(scratch, 'claude');
  configPath = join(scratch, CONFIG_FILENAME);
  lockfilePath = join(scratch, LOCKFILE_FILENAME);
  await fs.mkdir(claudeHome, { recursive: true });
  fixture = await createLocalGitFixture('ccpp-sync-test');
  await fs.mkdir(join(fixture.workPath, 'commands'), { recursive: true });
  await fixture.advance('commands/hello.md', '# hello\n');
  prevCache = process.env['CCPP_CACHE'];
  process.env['CCPP_CACHE'] = cacheRoot;
});

afterEach(async () => {
  if (prevCache === undefined) delete process.env['CCPP_CACHE'];
  else process.env['CCPP_CACHE'] = prevCache;
  await fixture.cleanup();
  await fs.rm(scratch, { recursive: true, force: true });
});

async function writeConfig(config: CcppConfig): Promise<void> {
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

describe('runSync — policy resolution', () => {
  it('(1) respects global syncPolicy=pinned', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      syncPolicy: 'pinned',
      sources: [{ url: fixture.url }],
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
    });
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]!.policy).toBe('pinned');
  }, 30_000);

  it('(2) respects global syncPolicy=latest', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      syncPolicy: 'latest',
      sources: [{ url: fixture.url }],
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
    });
    expect(report.sources[0]!.policy).toBe('latest');
  }, 30_000);

  it('(3) per-source policy overrides global', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      syncPolicy: 'pinned',
      sources: [{ url: fixture.url, policy: 'latest' }],
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
    });
    expect(report.sources[0]!.policy).toBe('latest');
  }, 30_000);

  it('(4) --prefer-latest (override=latest) wins over both config layers', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      syncPolicy: 'pinned',
      sources: [{ url: fixture.url, policy: 'pinned' }],
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
      override: 'latest',
    });
    expect(report.sources[0]!.policy).toBe('latest');
  }, 30_000);

  it('(5) --pinned (override=pinned) wins over both config layers', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      syncPolicy: 'latest',
      sources: [{ url: fixture.url, policy: 'latest' }],
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
      override: 'pinned',
    });
    expect(report.sources[0]!.policy).toBe('pinned');
  }, 30_000);
});

describe('resolveOverride — flag mutual exclusion', () => {
  it('(6) --prefer-latest + --pinned together throws (exit 1)', () => {
    try {
      resolveOverride({ preferLatest: true, pinned: true });
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/mutually exclusive/i);
      expect((err as { exitCode?: number }).exitCode).toBe(1);
    }
  });

  it('--update is an alias for --prefer-latest → latest', () => {
    expect(resolveOverride({ update: true })).toBe('latest');
  });

  it('no flags → undefined (fall back to config layers)', () => {
    expect(resolveOverride({})).toBeUndefined();
  });
});
