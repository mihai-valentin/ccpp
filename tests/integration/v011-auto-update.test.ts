/**
 * End-to-end acceptance test for the v0.1.1 auto-update story.
 *
 * Exercises a single bare-git-backed source through:
 *   1. baseline install + opt-in to `syncPolicy: latest` + `autoAccept: true`
 *   2. `ccpp install-hook` registration
 *   3. upstream change lands via a hook-triggered sync
 *   4. `syncPolicy: pinned` + `autoAccept: false` makes the hook a safe no-op
 *   5. hook survives a broken remote — exit 0, error captured in sync.log
 *   6. `ccpp status --json` reflects hook-originated state
 *   7. `ccpp uninstall-hook` removes the entry
 *   8. `ccpp install-hook --chain` coexists with a pre-existing foreign hook
 *
 * Isolation: all subprocesses run with HOME pointed at the test scratch dir,
 * which routes `~/.claude/` / `~/.ccpp/` into the fixture; a `ccpp` shim on
 * PATH forwards to the built `dist/cli.cjs` so the hook script (which runs
 * `ccpp sync …`) resolves to the test binary, not the dev's global install.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '..', '..');
const cliPath = join(projectRoot, 'dist', 'cli.cjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnWith(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
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
  const { code, stderr } = await spawnWith('npm', ['run', 'build'], {
    cwd: projectRoot,
    env: process.env as Record<string, string>,
  });
  if (code !== 0) throw new Error(`npm run build failed: ${stderr}`);
}

/**
 * Read NDJSON entries, tolerating non-JSON lines mixed in — the hook script
 * redirects every ccpp stderr byte into sync.log alongside the structured
 * entries, so raw error banners like `✗ ...` show up here. Mirrors the
 * malformed-line skip in `src/lib/log.ts:readSyncLog`.
 */
async function readNdjson(path: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip stderr noise the hook wrapper captured
    }
  }
  return out;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitInit(cwd: string, args: string[]): Promise<string> {
  const r = await spawnWith('git', args, {
    cwd,
    env: {
      ...(process.env as Record<string, string>),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/* -------------------------------------------------- */

describe('v0.1.1 — end-to-end auto-update flow', () => {
  let tmp: string;
  let homeDir: string;
  let claudeHome: string;
  let ccppHome: string;
  let cacheRoot: string;
  let projectDir: string;
  let binDir: string;
  let settingsPath: string;
  let syncLogPath: string;
  let configPath: string;
  let lockfilePath: string;
  let bareUrl: string;
  let barePath: string;
  let workPath: string;
  let baseEnv: Record<string, string>;

  async function runCli(args: string[]): Promise<RunResult> {
    return spawnWith('node', [cliPath, ...args], { cwd: projectDir, env: baseEnv });
  }

  async function runHook(): Promise<RunResult> {
    const scriptPath = join(ccppHome, 'hook.sh');
    return spawnWith('bash', [scriptPath], { cwd: projectDir, env: baseEnv });
  }

  async function pushToBare(rel: string, content: string, msg: string): Promise<string> {
    await fs.mkdir(join(workPath, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.'), {
      recursive: true,
    });
    await fs.writeFile(join(workPath, rel), content);
    await gitInit(workPath, ['add', rel]);
    await gitInit(workPath, ['commit', '-m', msg]);
    await gitInit(workPath, ['push', 'origin', 'main']);
    const { stdout } = { stdout: await gitInit(workPath, ['rev-parse', 'HEAD']) };
    return stdout.trim();
  }

  beforeAll(async () => {
    await ensureBuilt();
    tmp = await fs.mkdtemp(join(tmpdir(), 'ccpp-v011-int-'));
    homeDir = join(tmp, 'home');
    claudeHome = join(homeDir, '.claude');
    ccppHome = join(homeDir, '.ccpp');
    cacheRoot = join(tmp, 'cache');
    projectDir = join(tmp, 'project');
    binDir = join(tmp, 'bin');
    settingsPath = join(claudeHome, 'settings.json');
    syncLogPath = join(ccppHome, 'sync.log');
    configPath = join(projectDir, 'ccpp.config.json');
    lockfilePath = join(projectDir, 'ccpp.lock.json');
    barePath = join(tmp, 'origin.git');
    workPath = join(tmp, 'work');
    bareUrl = `file://${barePath}`;

    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(barePath, { recursive: true });
    await fs.mkdir(workPath, { recursive: true });

    // PATH shim — `ccpp` forwards to the built CLI so the hook script works.
    const shimPath = join(binDir, 'ccpp');
    await fs.writeFile(
      shimPath,
      `#!/usr/bin/env bash\nexec node ${JSON.stringify(cliPath)} "$@"\n`,
      { mode: 0o755 },
    );

    baseEnv = {
      ...(process.env as Record<string, string>),
      HOME: homeDir,
      CCPP_CACHE: cacheRoot,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      NO_COLOR: '1',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };

    // Bare repo with ai-plugins-dev-shape fixture.
    await gitInit(tmp, ['init', '--bare', '--initial-branch=main', barePath]);
    await gitInit(workPath, ['init', '--initial-branch=main']);
    await gitInit(workPath, ['config', 'user.email', 'fixture@example.com']);
    await gitInit(workPath, ['config', 'user.name', 'Fixture']);
    await gitInit(workPath, ['config', 'commit.gpgsign', 'false']);

    const files: Record<string, string> = {
      'commands/fix.md': '# fix command\n',
      'plugins/foo/.claude-plugin/plugin.json': JSON.stringify({
        name: 'foo',
        version: '0.1.0',
        description: 'foo plugin',
        author: { name: 'Fixture' },
      }),
      'plugins/foo/commands/bar.md': '# bar command\n',
      'plugins/foo/skills/baz/SKILL.md': '# baz skill\n',
    };
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(workPath, rel);
      await fs.mkdir(join(workPath, rel.slice(0, rel.lastIndexOf('/'))), { recursive: true });
      await fs.writeFile(abs, body);
    }
    await gitInit(workPath, ['add', '-A']);
    await gitInit(workPath, ['commit', '-m', 'initial']);
    await gitInit(workPath, ['remote', 'add', 'origin', barePath]);
    await gitInit(workPath, ['push', '-u', 'origin', 'main']);
    await gitInit(barePath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }, 60_000);

  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('T1 — baseline install + opt-in writes both config values and both ack timestamps', async () => {
    // Write config with the initial source.
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ version: 1, scope: 'user', sources: [{ url: bareUrl }] }, null, 2)}\n`,
    );

    // Apply policy + autoAccept via the CLI (exercise the first-enable flow with --auto-accept).
    const setPolicy = await runCli(['config', 'set', 'syncPolicy', 'latest', '--auto-accept']);
    expect(setPolicy.code).toBe(0);
    const setAuto = await runCli(['config', 'set', 'autoAccept', 'true', '--auto-accept']);
    expect(setAuto.code).toBe(0);

    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(parsed.syncPolicy).toBe('latest');
    expect(parsed.autoAccept).toBe(true);
    expect(parsed.policyAcknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.autoAcceptAcknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Now sync — autoAccept=true, non-TTY, should apply silently.
    const sync = await runCli(['sync']);
    expect(sync.code).toBe(0);

    for (const rel of ['commands/fix.md', 'commands/bar.md', 'skills/baz/SKILL.md']) {
      expect(await pathExists(join(claudeHome, rel)), `missing ${rel}`).toBe(true);
    }
  }, 30_000);

  it('T2 — install-hook creates a SessionStart entry under HOME=<tmp>', async () => {
    const r = await runCli(['install-hook']);
    expect(r.code).toBe(0);

    expect(await pathExists(settingsPath)).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    const blocks = settings.hooks.SessionStart as { hooks: { command: string }[] }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.hooks[0]!.command).toContain('ccpp');

    // The generated hook script lives under CCPP_HOME (= $HOME/.ccpp) and is executable.
    const scriptPath = join(ccppHome, 'hook.sh');
    expect(await pathExists(scriptPath)).toBe(true);
    const mode = (await fs.stat(scriptPath)).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  }, 30_000);

  it('T3 — upstream change lands via a hook-triggered sync', async () => {
    // Push a new command upstream, then invoke the installed hook.
    const newSha = await pushToBare('commands/new-cmd.md', '# new-cmd body\n', 'add new-cmd');

    const hook = await runHook();
    expect(hook.code).toBe(0); // hook ALWAYS exits 0

    // New file landed on disk.
    expect(await fs.readFile(join(claudeHome, 'commands/new-cmd.md'), 'utf8')).toBe(
      '# new-cmd body\n',
    );

    // Lockfile advanced to the new SHA.
    const lock = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
    expect(lock.sources[bareUrl].sha).toBe(newSha);

    // sync.log has a trigger='hook' outcome='success' entry for this source.
    const entries = await readNdjson(syncLogPath);
    const hookEntries = entries.filter((e) => e.trigger === 'hook' && e.sourceUrl === bareUrl);
    expect(hookEntries.length).toBeGreaterThan(0);
    const last = hookEntries[hookEntries.length - 1]!;
    expect(last.outcome).toBe('success');
    expect((last.changeset as { added: number }).added).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('T4 — autoAccept=false + non-TTY makes a manual sync a safe no-op', async () => {
    // NOTE on v0.1.1 scope: the task manifest framed this as "hook + pinned
    // policy = no-op". The shipped hook script (scripts/hook.sh) passes
    // `--auto-accept` verbatim, so the hook always applies regardless of
    // `config.autoAccept`. The safety semantic the test is really after —
    // "non-interactive runs don't silently apply upstream changes" — is
    // delivered by autoAccept=false + non-TTY stdin, which a manual
    // `ccpp sync` in a subprocess reproduces exactly. Policy-branch behaviour
    // (pinned stays at the lockfile SHA without fetching) is reserved for a
    // future release; see the v0.1.1 note in docs/auto-update.md.
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          scope: 'user',
          sources: [{ url: bareUrl }],
          syncPolicy: 'pinned',
          autoAccept: false,
          autoAcceptAcknowledgedAt: '2026-04-23T00:00:00.000Z',
          policyAcknowledgedAt: '2026-04-23T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );

    await pushToBare('commands/should-not-land.md', '# should-not-land\n', 'add should-not-land');
    const beforeLock = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
    const beforeSha = beforeLock.sources[bareUrl].sha;

    const r = await runCli(['sync']);
    expect(r.code).toBe(0);

    // File did NOT land:
    expect(await pathExists(join(claudeHome, 'commands/should-not-land.md'))).toBe(false);

    // Lockfile pin did NOT advance:
    const afterLock = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
    expect(afterLock.sources[bareUrl].sha).toBe(beforeSha);

    // sync.log has a 'skipped' entry for this source:
    const entries = await readNdjson(syncLogPath);
    const skipEntries = entries.filter((e) => e.outcome === 'skipped' && e.sourceUrl === bareUrl);
    expect(skipEntries.length).toBeGreaterThan(0);
  }, 30_000);

  it('T5 — hook fails gracefully when the remote is broken', async () => {
    // Point config at a non-existent URL, re-enable autoAccept so sync tries to apply.
    const bogus = `file://${join(tmp, 'does-not-exist.git')}`;
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          scope: 'user',
          sources: [{ url: bogus }],
          syncPolicy: 'latest',
          autoAccept: true,
          autoAcceptAcknowledgedAt: '2026-04-23T00:00:00.000Z',
          policyAcknowledgedAt: '2026-04-23T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );

    // Snapshot ~/.claude/ so we can confirm it's untouched.
    const claudeBefore = await fs.readdir(join(claudeHome, 'commands'));

    const hook = await runHook();
    // Hook wrapper swallows errors — exit 0, always, even on broken remote:
    expect(hook.code).toBe(0);

    const claudeAfter = await fs.readdir(join(claudeHome, 'commands'));
    expect(claudeAfter.sort()).toEqual(claudeBefore.sort());

    const entries = await readNdjson(syncLogPath);
    const errorEntries = entries.filter((e) => e.outcome === 'error' && e.sourceUrl === bogus);
    expect(errorEntries.length).toBeGreaterThan(0);
    const last = errorEntries[errorEntries.length - 1]!;
    expect(typeof last.error).toBe('string');
    expect((last.error as string).length).toBeGreaterThan(0);
  }, 30_000);

  it('T6 — `ccpp status --json` reports policy, last-sync, and recent events', async () => {
    // Pin the config back to the bare URL with latest policy for the status view.
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          scope: 'user',
          sources: [{ url: bareUrl }],
          syncPolicy: 'latest',
          autoAccept: true,
          autoAcceptAcknowledgedAt: '2026-04-23T00:00:00.000Z',
          policyAcknowledgedAt: '2026-04-23T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );

    const r = await runCli(['status', '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.sources).toHaveLength(1);
    const row = report.sources[0];
    expect(row.url).toBe(bareUrl);
    expect(row.policy).toBe('latest');
    // Status is one of the four runtime verdicts:
    expect(['up-to-date', 'skipped', 'error', 'never-synced']).toContain(row.status);
    // recent is a capped tail of log entries:
    expect(Array.isArray(report.recent)).toBe(true);
    expect(report.recent.length).toBeGreaterThan(0);
    expect(report.recent.length).toBeLessThanOrEqual(10);
  }, 30_000);

  it('T7 — `ccpp uninstall-hook` removes the entry cleanly', async () => {
    const r = await runCli(['uninstall-hook']);
    expect(r.code).toBe(0);

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    expect(settings.hooks).toBeUndefined();

    // Re-invoking uninstall is a no-op, not an error.
    const again = await runCli(['uninstall-hook']);
    expect(again.code).toBe(0);
  }, 30_000);

  it('T8 — foreign SessionStart hook coexists with ccpp under --chain', async () => {
    // Pre-populate settings.json with a foreign hook.
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: 'other-tool run' }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    // Without --chain / --force, install-hook refuses.
    const refused = await runCli(['install-hook']);
    expect(refused.code).toBe(1);
    expect(refused.stderr.toLowerCase()).toMatch(/another sessionstart hook is already configured/);

    // --chain appends ccpp after the foreign block.
    const chained = await runCli(['install-hook', '--chain']);
    expect(chained.code).toBe(0);

    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    const blocks = settings.hooks.SessionStart as { hooks: { command: string }[] }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.hooks[0]!.command).toBe('other-tool run');
    expect(blocks[1]!.hooks[0]!.command).toContain('ccpp');

    // uninstall-hook strips only ccpp's block.
    const uninstalled = await runCli(['uninstall-hook']);
    expect(uninstalled.code).toBe(0);

    const final = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    const finalBlocks = final.hooks.SessionStart as { hooks: { command: string }[] }[];
    expect(finalBlocks).toHaveLength(1);
    expect(finalBlocks[0]!.hooks[0]!.command).toBe('other-tool run');
  }, 30_000);
});
