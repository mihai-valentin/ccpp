import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCcppBlock, runInstallHook } from './install-hook.js';

let scratch: string;
let claudeHome: string;
let ccppHome: string;
let cwd: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-hook-install-'));
  claudeHome = join(scratch, 'claude');
  ccppHome = join(scratch, 'ccpp-home');
  cwd = join(scratch, 'project');
  await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function readSettings(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('runInstallHook — user scope', () => {
  it('creates settings.json with a ccpp SessionStart entry when none exists', async () => {
    const r = await runInstallHook({ scope: 'user', claudeHome, ccppHome, quiet: true });
    expect(r.action).toBe('created');
    expect(r.settingsPath).toBe(join(claudeHome, 'settings.json'));
    expect(r.scriptPath).toBe(join(ccppHome, 'hook.sh'));

    const s = await readSettings(r.settingsPath);
    const sessionStart = (s.hooks as { SessionStart: unknown[] }).SessionStart;
    expect(Array.isArray(sessionStart)).toBe(true);
    expect(sessionStart).toHaveLength(1);

    const script = await fs.readFile(r.scriptPath, 'utf8');
    expect(script).toContain('ccpp sync --auto-accept --trigger hook');
    // Script is executable
    const mode = (await fs.stat(r.scriptPath)).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  });

  it('is idempotent — re-running updates the same ccpp block in place', async () => {
    const first = await runInstallHook({ scope: 'user', claudeHome, ccppHome, quiet: true });
    expect(first.action).toBe('created');
    const second = await runInstallHook({ scope: 'user', claudeHome, ccppHome, quiet: true });
    expect(second.action).toBe('updated');

    const s = await readSettings(first.settingsPath);
    const sessionStart = (s.hooks as { SessionStart: unknown[] }).SessionStart;
    expect(sessionStart).toHaveLength(1);
  });

  it('refuses to clobber a foreign SessionStart hook without --chain or --force', async () => {
    const settingsPath = join(claudeHome, 'settings.json');
    await fs.mkdir(claudeHome, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool run' }] }],
        },
      }),
    );

    await expect(
      runInstallHook({ scope: 'user', claudeHome, ccppHome, quiet: true }),
    ).rejects.toThrow(/another SessionStart hook is already configured/i);
    // Settings file unchanged:
    const s = await readSettings(settingsPath);
    expect((s.hooks as { SessionStart: unknown[] }).SessionStart).toHaveLength(1);
  });

  it('--chain appends ccpp after the existing foreign block', async () => {
    const settingsPath = join(claudeHome, 'settings.json');
    await fs.mkdir(claudeHome, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool run' }] }],
        },
      }),
    );
    const r = await runInstallHook({
      scope: 'user',
      claudeHome,
      ccppHome,
      chain: true,
      quiet: true,
    });
    expect(r.action).toBe('chained');

    const s = await readSettings(settingsPath);
    const blocks = (s.hooks as { SessionStart: { hooks: { command: string }[] }[] }).SessionStart;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.hooks[0]!.command).toBe('other-tool run');
    expect(blocks[1]!.hooks[0]!.command).toContain('ccpp');
  });

  it('--force replaces every SessionStart block with just ccpp', async () => {
    const settingsPath = join(claudeHome, 'settings.json');
    await fs.mkdir(claudeHome, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool run' }] }],
        },
      }),
    );
    const r = await runInstallHook({
      scope: 'user',
      claudeHome,
      ccppHome,
      force: true,
      quiet: true,
    });
    expect(r.action).toBe('replaced');

    const s = await readSettings(settingsPath);
    const blocks = (s.hooks as { SessionStart: { hooks: { command: string }[] }[] }).SessionStart;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.hooks[0]!.command).toContain('ccpp');
  });

  it('--chain + --force together errors', async () => {
    await expect(
      runInstallHook({
        scope: 'user',
        claudeHome,
        ccppHome,
        chain: true,
        force: true,
        quiet: true,
      }),
    ).rejects.toThrow(/mutually exclusive/i);
  });
});

describe('runInstallHook — project scope', () => {
  it('writes to <cwd>/.claude/settings.json when scope=project', async () => {
    const r = await runInstallHook({ scope: 'project', cwd, ccppHome, quiet: true });
    expect(r.settingsPath).toBe(join(cwd, '.claude', 'settings.json'));
    expect(r.action).toBe('created');
    const s = await readSettings(r.settingsPath);
    expect((s.hooks as { SessionStart: unknown[] }).SessionStart).toHaveLength(1);
  });

  it('preserves unrelated settings keys and other hook categories', async () => {
    const settingsPath = join(cwd, '.claude', 'settings.json');
    await fs.mkdir(join(cwd, '.claude'), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        model: 'sonnet',
        hooks: {
          UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'other' }] }],
        },
      }),
    );
    await runInstallHook({ scope: 'project', cwd, ccppHome, quiet: true });

    const s = await readSettings(settingsPath);
    expect(s.model).toBe('sonnet');
    const hooks = s.hooks as Record<string, unknown>;
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.SessionStart).toBeDefined();
  });
});

describe('isCcppBlock', () => {
  it('detects a block whose command contains "ccpp"', () => {
    expect(isCcppBlock({ hooks: [{ type: 'command', command: 'bash /foo/ccpp/hook.sh' }] })).toBe(
      true,
    );
  });

  it('returns false for foreign blocks', () => {
    expect(isCcppBlock({ hooks: [{ type: 'command', command: 'other-tool run' }] })).toBe(false);
  });
});
