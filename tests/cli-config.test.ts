import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
    // fall through
  }
  const { code, stderr } = await run('npm', ['run', 'build'], { cwd: projectRoot });
  if (code !== 0) throw new Error(`npm run build failed: ${stderr}`);
}

function cli(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<RunResult> {
  return run('node', [cliPath, ...args], opts);
}

let scratch: string;

beforeAll(async () => {
  await ensureBuilt();
}, 120_000);

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-cli-config-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('ccpp --help lists the config subcommand', () => {
  it('shows `config` in the command list', async () => {
    const { code, stdout } = await cli(['--help'], { cwd: scratch });
    expect(code).toBe(0);
    expect(stdout).toMatch(/config.*Manage ccpp configuration/);
  });
});

describe('ccpp config list', () => {
  it('works on a fresh repo with no ccpp.config.json (defaults only)', async () => {
    const { code, stdout } = await cli(['config', 'list'], { cwd: scratch });
    expect(code).toBe(0);
    expect(stdout).toMatch(/syncPolicy.*pinned/);
    expect(stdout).toMatch(/autoAccept.*false/);
  });

  it('--json emits valid JSON for an empty config', async () => {
    const { code, stdout } = await cli(['config', 'list', '--json'], { cwd: scratch });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.syncPolicy).toBe('pinned');
    expect(parsed.autoAccept).toBe(false);
  });
});

describe('ccpp config set / get', () => {
  it('set syncPolicy pinned persists without requiring --auto-accept', async () => {
    const init = await cli(['init'], { cwd: scratch });
    expect(init.code).toBe(0);

    const set = await cli(['config', 'set', 'syncPolicy', 'pinned'], { cwd: scratch });
    expect(set.code).toBe(0);
    expect(set.stdout).toMatch(/syncPolicy.*pinned/);

    const raw = await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.syncPolicy).toBe('pinned');
  });

  it('set syncPolicy latest --auto-accept persists value AND policyAcknowledgedAt', async () => {
    const init = await cli(['init'], { cwd: scratch });
    expect(init.code).toBe(0);

    const set = await cli(
      ['config', 'set', 'syncPolicy', 'latest', '--auto-accept'],
      { cwd: scratch },
    );
    expect(set.code).toBe(0);

    const raw = await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.syncPolicy).toBe('latest');
    expect(parsed.policyAcknowledgedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    // Subsequent policy set/reset flips don't re-prompt — ack is sticky.
    const roundtrip = await cli(['config', 'set', 'syncPolicy', 'pinned'], { cwd: scratch });
    expect(roundtrip.code).toBe(0);
    const back = await cli(['config', 'set', 'syncPolicy', 'latest'], { cwd: scratch });
    expect(back.code).toBe(0);

    const get = await cli(['config', 'get', 'syncPolicy'], { cwd: scratch });
    expect(get.code).toBe(0);
    expect(get.stdout.trim()).toBe('latest');
  });

  it('set autoAccept true --auto-accept persists value AND autoAcceptAcknowledgedAt', async () => {
    await cli(['init'], { cwd: scratch });
    const set = await cli(
      ['config', 'set', 'autoAccept', 'true', '--auto-accept'],
      { cwd: scratch },
    );
    expect(set.code).toBe(0);

    const parsed = JSON.parse(await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8'));
    expect(parsed.autoAccept).toBe(true);
    expect(parsed.autoAcceptAcknowledgedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe('ccpp config error paths', () => {
  it('get on an unknown key exits 1', async () => {
    const { code, stderr } = await cli(['config', 'get', 'bogus-key'], { cwd: scratch });
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown config key/i);
  });

  it('set with an invalid value exits 1', async () => {
    const { code, stderr } = await cli(['config', 'set', 'syncPolicy', 'forever'], {
      cwd: scratch,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/invalid value/i);
  });

  it('unknown action exits 1', async () => {
    const { code, stderr } = await cli(['config', 'do-a-dance'], { cwd: scratch });
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown action/i);
  });

  it('set syncPolicy latest without --auto-accept in a non-TTY exits 1', async () => {
    const { code, stderr } = await cli(['config', 'set', 'syncPolicy', 'latest'], {
      cwd: scratch,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/requires confirmation.*--auto-accept|interactive terminal/i);
  });

  it('set autoAccept true without --auto-accept in a non-TTY exits 1', async () => {
    const { code, stderr } = await cli(['config', 'set', 'autoAccept', 'true'], {
      cwd: scratch,
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/requires confirmation.*--auto-accept|interactive terminal/i);
  });
});
