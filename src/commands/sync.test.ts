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
const savedEnv: Record<string, string | undefined> = {};

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
  // Isolate from host git config — avoids core.autocrlf=true rewriting LF→CRLF on checkout.
  for (const key of ['CCPP_CACHE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[key] = process.env[key];
  }
  process.env['CCPP_CACHE'] = cacheRoot;
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  process.env['GIT_CONFIG_SYSTEM'] = '/dev/null';
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

describe('runSync — diff preview and apply gate', () => {
  it('(DA1) config.autoAccept=true skips the prompt and applies', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      sources: [{ url: fixture.url }],
      autoAccept: true,
      autoAcceptAcknowledgedAt: '2026-04-23T00:00:00Z',
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
    });
    expect(report.sources[0]!.applyStatus).toBe('applied');
    expect(report.sources[0]!.installed).toContain(join(claudeHome, 'commands', 'hello.md'));
    // File actually landed on disk:
    expect(await fs.readFile(join(claudeHome, 'commands', 'hello.md'), 'utf8')).toBe('# hello\n');
  }, 30_000);

  it('(DA2) --auto-accept flag skips the prompt and applies', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      sources: [{ url: fixture.url }],
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
      autoAccept: true,
    });
    expect(report.sources[0]!.applyStatus).toBe('applied');
    expect(await fs.readFile(join(claudeHome, 'commands', 'hello.md'), 'utf8')).toBe('# hello\n');
  }, 30_000);

  it('(DA3) autoAccept=false + non-TTY skips apply and records skipped-no-prompt', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      sources: [{ url: fixture.url }],
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
      isTTY: false,
    });
    expect(report.sources[0]!.applyStatus).toBe('skipped-no-prompt');
    expect(report.sources[0]!.installed).toEqual([]);
    // hello.md was NOT written:
    await expect(fs.access(join(claudeHome, 'commands', 'hello.md'))).rejects.toThrow();
    // Lockfile sources entry stayed empty since priorSha was null:
    const lock = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
    expect(lock.sources[fixture.url]).toBeUndefined();
  }, 30_000);

  it('(DA4) --json + autoAccept=false emits skipped-no-prompt without prompting', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      sources: [{ url: fixture.url }],
    });
    // confirm would throw if it were ever called — --json must bypass it.
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: true,
      quiet: true,
      isTTY: true,
      confirm: () => {
        throw new Error('confirm must not be called in --json mode');
      },
    });
    expect(report.sources[0]!.applyStatus).toBe('skipped-no-prompt');
    expect(report.sources[0]!.changeset.added).toContain(
      join(claudeHome, 'commands', 'hello.md'),
    );
  }, 30_000);

  it('(DA5) verbose expands the proposal to per-file paths', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      sources: [{ url: fixture.url }],
    });
    let capturedPrompt = '';
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
      verbose: true,
      isTTY: true,
      confirm: (prompt) => {
        capturedPrompt = prompt;
        return true;
      },
    });
    expect(report.sources[0]!.applyStatus).toBe('applied');
    // Header line is present in both verbose and non-verbose modes…
    expect(capturedPrompt).toMatch(/proposes: \+1 added, ~0 modified, -0 removed/);
    // …but verbose also expands the per-file bullet list.
    expect(capturedPrompt).toContain(`+ ${join(claudeHome, 'commands', 'hello.md')}`);
  }, 30_000);

  it('confirm → user-declined leaves disk untouched', async () => {
    await writeConfig({
      version: 1,
      scope: 'user',
      sources: [{ url: fixture.url }],
    });
    const report = await runSync({
      configPath,
      lockfilePath,
      claudeHome,
      json: false,
      quiet: true,
      isTTY: true,
      confirm: () => false,
    });
    expect(report.sources[0]!.applyStatus).toBe('user-declined');
    await expect(fs.access(join(claudeHome, 'commands', 'hello.md'))).rejects.toThrow();
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
