import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalGitFixture } from './helpers/local-git-fixture.js';

const projectRoot = resolve(__dirname, '..');
const cliPath = join(projectRoot, 'dist', 'cli.cjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', ...opts.env },
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
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

async function ensureBuilt(): Promise<void> {
  try {
    await fs.access(cliPath);
    return;
  } catch {
    // fall through to build
  }
  const { code, stderr } = await run('npm', ['run', 'build'], { cwd: projectRoot });
  if (code !== 0) throw new Error(`npm run build failed: ${stderr}`);
}

function cli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<RunResult> {
  return run('node', [cliPath, ...args], opts);
}

let scratch: string;

beforeAll(async () => {
  await ensureBuilt();
}, 120_000);

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-cli-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('ccpp --help', () => {
  it('exits 0 and lists all five subcommands plus the exit-code epilog', async () => {
    const { code, stdout } = await cli(['--help'], { cwd: scratch });
    expect(code).toBe(0);
    for (const sub of ['init', 'install', 'sync', 'list', 'uninstall']) {
      expect(stdout).toContain(sub);
    }
    expect(stdout).toContain('Exit codes:');
    for (const line of ['0  success', '1  user error', '2  environment error', '3  collision']) {
      expect(stdout).toContain(line);
    }
  });
});

describe('ccpp init', () => {
  it('writes ccpp.config.json with the expected empty shape', async () => {
    const { code, stdout } = await cli(['init'], { cwd: scratch });
    expect(code).toBe(0);
    expect(stdout).toContain('ccpp.config.json');
    const parsed = JSON.parse(await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8'));
    expect(parsed).toEqual({ scope: 'user', sources: [], version: 1 });
  });

  it('records the first source when --source is passed', async () => {
    const { code } = await cli(
      ['init', '--source', 'https://example.com/foo.git', '--ref', 'main'],
      { cwd: scratch },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8'));
    expect(parsed.sources).toEqual([{ ref: 'main', url: 'https://example.com/foo.git' }]);
  });

  it('refuses to overwrite an existing config, but succeeds with --force', async () => {
    const cfgPath = join(scratch, 'ccpp.config.json');
    await fs.writeFile(cfgPath, '{"version":1,"sources":[],"scope":"user"}');

    const refused = await cli(['init'], { cwd: scratch });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/refusing to overwrite/i);

    const forced = await cli(['init', '--force'], { cwd: scratch });
    expect(forced.code).toBe(0);
  });
});

describe('ccpp list', () => {
  it('with no lockfile exits 0 and reports an empty install', async () => {
    const { code, stdout } = await cli(['list'], { cwd: scratch });
    expect(code).toBe(0);
    expect(stdout).toContain('(nothing installed)');
  });

  it('--json emits an empty rows array when nothing is installed', async () => {
    const { code, stdout } = await cli(['list', '--json'], { cwd: scratch });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ rows: [] });
  });
});

describe('exit codes', () => {
  it('exits 1 when `install` is called with no URL on a non-TTY (no fresh-config)', async () => {
    // Our spawn harness attaches pipes, not a pty — stdin.isTTY is false — so
    // the wizard refuses and directs the user at the non-interactive form.
    const { code, stderr } = await cli(['install'], { cwd: scratch });
    expect(code).toBe(1);
    expect(stderr).toMatch(/no <url> provided and stdin is not a tty/i);
  });

  it('exits 1 when `install` is called with no URL but config already exists', async () => {
    await fs.writeFile(
      join(scratch, 'ccpp.config.json'),
      JSON.stringify({ version: 1, scope: 'user', sources: [] }),
    );
    const { code, stderr } = await cli(['install'], { cwd: scratch });
    expect(code).toBe(1);
    expect(stderr).toMatch(/ccpp\.config\.json already exists/i);
    // Message must point the user at the non-interactive form, not re-prompt:
    expect(stderr).toMatch(/ccpp install <url>/);
  });

  it('rejects --ref / --prefer / --scratch / --prefer-latest / --yes when called without a URL', async () => {
    for (const flag of ['--ref=main', '--prefer', '--scratch', '--prefer-latest', '--yes']) {
      const { code, stderr } = await cli(['install', flag], { cwd: scratch });
      expect(code, `expected exit 1 for ${flag}, got ${code}`).toBe(1);
      expect(stderr).toMatch(/require a <url>/i);
    }
  });

  it('rejects --prefer-latest with --scratch (nowhere to persist policy)', async () => {
    const { code, stderr } = await cli(
      ['install', 'git@example.com:x/y.git', '--prefer-latest', '--scratch'],
      { cwd: scratch },
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/incompatible with --scratch/i);
  });

  it('rejects --prefer-latest on a non-TTY without --yes (hint at --yes)', async () => {
    // Our spawn harness attaches pipes, so stdin.isTTY is false — the ack
    // can't be resolved interactively, and we must nudge the user at --yes.
    const fx = await createLocalGitFixture('ccpp-cli-plat-nonyes');
    try {
      const claudeHome = join(scratch, 'claude');
      const cacheRoot = join(scratch, 'cache');
      const { code, stderr } = await cli(
        ['install', fx.url, '--prefer-latest', '--claude-home', claudeHome],
        { cwd: scratch, env: { CCPP_CACHE: cacheRoot } },
      );
      expect(code).toBe(1);
      expect(stderr).toMatch(/--yes/i);
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('exits 1 when `sync` runs with no ccpp.config.json', async () => {
    const { code, stderr } = await cli(['sync'], { cwd: scratch });
    expect(code).toBe(1);
    expect(stderr).toMatch(/ccpp\.config\.json/);
  });

  it('exits 2 when `install` hits a git source that cannot be cloned', async () => {
    const claudeHome = join(scratch, 'claude');
    const cacheRoot = join(scratch, 'cache');
    const bogus = `file://${join(scratch, 'does-not-exist.git')}`;
    const { code, stderr } = await cli(['install', bogus, '--claude-home', claudeHome], {
      cwd: scratch,
      env: { CCPP_CACHE: cacheRoot },
    });
    expect(code).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('--prefer-latest --yes persists policy:latest on the source and stamps the ack', async () => {
    const fx = await createLocalGitFixture('ccpp-cli-plat-yes');
    try {
      await fs.mkdir(join(fx.workPath, 'commands'), { recursive: true });
      await fx.advance('commands/one.md', '# one\n');
      const claudeHome = join(scratch, 'claude');
      const cacheRoot = join(scratch, 'cache');

      const { code } = await cli(
        ['install', fx.url, '--prefer-latest', '--yes', '--claude-home', claudeHome],
        { cwd: scratch, env: { CCPP_CACHE: cacheRoot } },
      );
      expect(code).toBe(0);

      const cfg = JSON.parse(await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8'));
      expect(cfg.sources).toEqual([{ policy: 'latest', url: fx.url }]);
      expect(typeof cfg.policyAcknowledgedAt).toBe('string');
      expect(cfg.policyAcknowledgedAt.length).toBeGreaterThan(0);
      // --yes on install is one-shot: does NOT set global autoAccept.
      expect(cfg.autoAccept).toBeUndefined();
    } finally {
      await fx.cleanup();
    }
  }, 30_000);

  it('--yes auto-resolves collisions (incoming wins) on re-install', async () => {
    const a = await createLocalGitFixture('ccpp-cli-yes-collide-a');
    const b = await createLocalGitFixture('ccpp-cli-yes-collide-b');
    try {
      await fs.mkdir(join(a.workPath, 'commands'), { recursive: true });
      await fs.mkdir(join(b.workPath, 'commands'), { recursive: true });
      await a.advance('commands/overlap.md', '# from A\n');
      await b.advance('commands/overlap.md', '# from B\n');

      const claudeHome = join(scratch, 'claude');
      const cacheRoot = join(scratch, 'cache');
      const env = { CCPP_CACHE: cacheRoot };

      const first = await cli(['install', a.url, '--claude-home', claudeHome], {
        cwd: scratch,
        env,
      });
      expect(first.code).toBe(0);

      const second = await cli(['install', b.url, '--yes', '--claude-home', claudeHome], {
        cwd: scratch,
        env,
      });
      expect(second.code).toBe(0);

      const overlap = await fs.readFile(join(claudeHome, 'commands', 'overlap.md'), 'utf8');
      expect(overlap.replace(/\r\n/g, '\n')).toBe('# from B\n');
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 30_000);

  it('exits 3 when two sources provide the same command', async () => {
    const a = await createLocalGitFixture('ccpp-cli-collide-a');
    const b = await createLocalGitFixture('ccpp-cli-collide-b');
    try {
      await fs.mkdir(join(a.workPath, 'commands'), { recursive: true });
      await fs.mkdir(join(b.workPath, 'commands'), { recursive: true });
      await a.advance('commands/overlap.md', '# from A\n');
      await b.advance('commands/overlap.md', '# from B\n');

      const claudeHome = join(scratch, 'claude');
      const cacheRoot = join(scratch, 'cache');
      const env = { CCPP_CACHE: cacheRoot };

      const first = await cli(['install', a.url, '--claude-home', claudeHome], {
        cwd: scratch,
        env,
      });
      expect(first.code).toBe(0);

      const second = await cli(['install', b.url, '--claude-home', claudeHome], {
        cwd: scratch,
        env,
      });
      expect(second.code).toBe(3);
      expect(second.stderr).toMatch(/collision/i);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 30_000);
});
