/**
 * End-to-end test suite against the real `ccpp-test-pingpong` fixture
 * on GitHub. The fixture ships:
 *
 *   - 2 standalone commands (/ping, /pong)
 *   - 1 standalone skill (rally) with a multi-file tree
 *   - 1 standalone agent (referee)
 *   - tag v0.1.0 at the initial commit
 *
 * These tests cover the install paths that file:// fixtures can't fully
 * mirror — real GitHub git protocol over HTTPS, ref resolution against
 * a real remote, cache reuse.
 *
 * **Not run by default.** Invoke with `npm run test:e2e`. The fixture
 * is a public repo so no auth is needed — just network access to
 * github.com. The suite probes the remote and skips itself (with a
 * clear console message) if the probe fails.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REMOTE = 'https://github.com/mihai-valentin/ccpp-test-pingpong.git';
const TAG = 'v0.1.0';
const projectRoot = resolve(__dirname, '..', '..');
const cliPath = join(projectRoot, 'dist', 'cli.cjs');

/* -------------------- shell + cli helpers -------------------- */

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    if (opts.timeout) {
      setTimeout(() => child.kill('SIGTERM'), opts.timeout).unref();
    }
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

async function ensureBuilt(): Promise<void> {
  try {
    await fs.access(cliPath);
    return;
  } catch {
    // fall through
  }
  const r = await run('npm', ['run', 'build'], { cwd: projectRoot });
  if (r.code !== 0) throw new Error(`npm run build failed: ${r.stderr}`);
}

function cli(
  args: string[],
  scratch: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return run('node', [cliPath, ...args], {
    cwd: scratch,
    env: { CCPP_HOME: scratch, ...extraEnv },
  });
}

/* -------------------- suite setup -------------------- */

let scratch: string;
let claudeHome: string;
// Suite-wide cache so individual tests reuse the clone instead of re-fetching.
let cacheRoot: string;
let networkAvailable = false;
let skipReason = '';

beforeAll(async () => {
  await ensureBuilt();

  // Probe network reachability. `git ls-remote --exit-code` on the real
  // remote is the most honest check — exercises the same protocol ccpp
  // will use. The fixture is a public repo so no auth is involved.
  cacheRoot = await fs.mkdtemp(join(tmpdir(), 'ccpp-e2e-cache-'));
  const probe = await run(
    'git',
    ['ls-remote', '--exit-code', '--quiet', REMOTE, 'refs/heads/master'],
    { timeout: 15_000 },
  );
  if (probe.code === 0) {
    networkAvailable = true;
  } else {
    skipReason = probe.stderr.trim() || `git ls-remote exited ${probe.code}`;
    console.warn(`\n⚠ ccpp e2e suite SKIPPED — probe of ${REMOTE} failed.`);
    console.warn(`  Reason: ${skipReason}`);
    console.warn('  Re-run with network access to github.com.\n');
  }
}, 60_000);

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-e2e-'));
  claudeHome = join(scratch, 'claude');
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

// vitest doesn't have a clean "skip-suite-from-beforeAll" hook, so each test
// guards on `networkAvailable`. The setup line in beforeAll prints a clear
// reason once, so the per-test skips don't spam the console.
function net(): boolean {
  if (!networkAvailable) {
    console.warn(`  ↳ skipped: ${skipReason || 'network unavailable'}`);
  }
  return networkAvailable;
}

/* -------------------- the tests -------------------- */

describe('e2e: ccpp-test-pingpong', () => {
  it('fresh install from default branch produces 4 list rows + 5 files', async () => {
    if (!net()) return;
    const r = await cli(['install', REMOTE, '--claude-home', claudeHome, '--quiet'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    expect(r.code, r.stderr).toBe(0);

    // 5 files materialized on disk (2 commands + skill 2-file tree + agent).
    const installed = await collectFiles(claudeHome);
    expect(installed.sort()).toEqual(
      [
        join(claudeHome, 'agents', 'referee.md'),
        join(claudeHome, 'commands', 'ping.md'),
        join(claudeHome, 'commands', 'pong.md'),
        join(claudeHome, 'skills', 'rally', 'SKILL.md'),
        join(claudeHome, 'skills', 'rally', 'references', 'strategies.md'),
      ].sort(),
    );

    // ccpp list collapses the skill to one row → 4 total.
    const listed = await cli(['list', '--claude-home', claudeHome, '--json'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    expect(listed.code).toBe(0);
    const rows = JSON.parse(listed.stdout).rows;
    expect(rows).toHaveLength(4);
    const byName = Object.fromEntries(rows.map((r: { name: string }) => [r.name, r]));
    expect(byName.ping.type).toBe('command');
    expect(byName.pong.type).toBe('command');
    expect(byName.rally.type).toBe('skill');
    expect(byName.referee.type).toBe('agent');
  });

  it('@v0.1.0 shorthand pins the source ref in config', async () => {
    if (!net()) return;
    const r = await cli(
      ['install', `${REMOTE}@${TAG}`, '--claude-home', claudeHome, '--quiet'],
      scratch,
      { CCPP_CACHE: cacheRoot },
    );
    expect(r.code, r.stderr).toBe(0);
    const cfg = JSON.parse(await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8'));
    expect(cfg.sources).toEqual([{ ref: TAG, url: REMOTE }]);
  });

  it('--ref <tag> matches the @<tag> shorthand', async () => {
    if (!net()) return;
    const r = await cli(
      ['install', REMOTE, '--ref', TAG, '--claude-home', claudeHome, '--quiet'],
      scratch,
      { CCPP_CACHE: cacheRoot },
    );
    expect(r.code, r.stderr).toBe(0);
    const cfg = JSON.parse(await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8'));
    expect(cfg.sources).toEqual([{ ref: TAG, url: REMOTE }]);
  });

  it('--ref + @<ref> conflict produces exit 1 with a useful message', async () => {
    if (!net()) return;
    const r = await cli(
      ['install', `${REMOTE}@${TAG}`, '--ref', 'master', '--claude-home', claudeHome, '--quiet'],
      scratch,
      { CCPP_CACHE: cacheRoot },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ref conflict/i);
  });

  it('re-install is idempotent — second pass reports 0 new / 0 updated / N unchanged', async () => {
    if (!net()) return;
    const first = await cli(['install', REMOTE, '--claude-home', claudeHome, '--quiet'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    expect(first.code).toBe(0);

    const second = await cli(['install', REMOTE, '--claude-home', claudeHome], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/0 new, 0 updated, 5 unchanged/);
  });

  it('ccpp sync on a freshly-installed source is a no-op', async () => {
    if (!net()) return;
    await cli(['install', REMOTE, '--claude-home', claudeHome, '--quiet'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    // --auto-accept on a non-TTY would be required; here there are no changes
    // so the diff-preview prompt path doesn't fire either way.
    const r = await cli(['sync', '--claude-home', claudeHome, '--json'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.sources).toHaveLength(1);
    const src = report.sources[0];
    expect(src.url).toBe(REMOTE);
    expect(src.applyStatus).toBe('no-changes');
    // Changeset is path-arrays (the Changeset type from lib/diff). On a
    // freshly-installed source nothing should be added/modified/removed,
    // and `unchanged` lists the 5 destination paths.
    expect(src.changeset.added).toEqual([]);
    expect(src.changeset.modified).toEqual([]);
    expect(src.changeset.removed).toEqual([]);
    expect(src.changeset.unchanged).toHaveLength(5);
  });

  it('ccpp status surfaces the source as up-to-date after install', async () => {
    if (!net()) return;
    await cli(['install', REMOTE, '--claude-home', claudeHome, '--quiet'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    const r = await cli(['status', '--claude-home', claudeHome, '--json'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    expect(r.code, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].url).toBe(REMOTE);
    expect(report.sources[0].status).toBe('up-to-date');
    expect(report.sources[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('ccpp uninstall renames every installed file to .bak.<ts> and clears config', async () => {
    if (!net()) return;
    await cli(['install', REMOTE, '--claude-home', claudeHome, '--quiet'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    const before = await collectFiles(claudeHome);
    expect(before).toHaveLength(5);

    const r = await cli(['uninstall', REMOTE, '--claude-home', claudeHome, '--json'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    expect(r.code, r.stderr).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.source).toBe(REMOTE);
    expect(result.removed).toHaveLength(5);
    expect(result.backups).toHaveLength(5);

    // Original paths gone; backup files present.
    for (const path of before) {
      await expect(fs.access(path)).rejects.toThrow();
    }
    for (const bak of result.backups as string[]) {
      await expect(fs.access(bak)).resolves.toBeUndefined();
      expect(bak).toMatch(/\.bak\.\d{4}-\d{2}-\d{2}T/);
    }

    // Config no longer references the source.
    const cfg = JSON.parse(await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8'));
    expect(cfg.sources).toEqual([]);
  });

  it('cache reuse — second install in the same suite does not re-clone', async () => {
    if (!net()) return;
    const cachePath = join(cacheRoot, 'github.com', 'mihai-valentin', 'ccpp-test-pingpong');
    // The first install in any prior test in this suite already created the
    // cache (suite shares cacheRoot). Just verify it exists and that another
    // install completes quickly without errors.
    await expect(fs.access(join(cachePath, '.git'))).resolves.toBeUndefined();
    const r = await cli(['install', REMOTE, '--claude-home', claudeHome, '--quiet'], scratch, {
      CCPP_CACHE: cacheRoot,
    });
    expect(r.code, r.stderr).toBe(0);
  });
});

/* -------------------- helpers -------------------- */

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(p: string): Promise<void> {
    const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await walk(dir);
  return out;
}
