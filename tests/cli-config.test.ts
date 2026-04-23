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
  it('set persists to ccpp.config.json and get reads it back', async () => {
    const init = await cli(['init'], { cwd: scratch });
    expect(init.code).toBe(0);

    const set = await cli(['config', 'set', 'syncPolicy', 'latest'], { cwd: scratch });
    expect(set.code).toBe(0);
    expect(set.stdout).toMatch(/syncPolicy.*latest/);

    const raw = await fs.readFile(join(scratch, 'ccpp.config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.syncPolicy).toBe('latest');

    const get = await cli(['config', 'get', 'syncPolicy'], { cwd: scratch });
    expect(get.code).toBe(0);
    expect(get.stdout.trim()).toBe('latest');

    const getJson = await cli(['config', 'get', 'syncPolicy', '--json'], { cwd: scratch });
    expect(getJson.code).toBe(0);
    expect(JSON.parse(getJson.stdout)).toEqual({ key: 'syncPolicy', value: 'latest' });
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
});
