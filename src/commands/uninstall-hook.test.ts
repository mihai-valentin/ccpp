import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstallHook } from './install-hook.js';
import { runUninstallHook } from './uninstall-hook.js';

let scratch: string;
let claudeHome: string;
let ccppHome: string;
let cwd: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-hook-uninstall-'));
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

describe('runUninstallHook', () => {
  it('is a no-op when settings.json does not exist', async () => {
    const r = await runUninstallHook({ scope: 'user', claudeHome, quiet: true });
    expect(r.removed).toBe(false);
    expect(r.noop).toBe(true);
  });

  it('is a no-op when settings.json has no SessionStart hook', async () => {
    const settingsPath = join(claudeHome, 'settings.json');
    await fs.mkdir(claudeHome, { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify({ model: 'sonnet' }));
    const r = await runUninstallHook({ scope: 'user', claudeHome, quiet: true });
    expect(r.removed).toBe(false);
    expect(r.noop).toBe(true);
  });

  it('removes the ccpp block after a prior install-hook', async () => {
    await runInstallHook({ scope: 'user', claudeHome, ccppHome, quiet: true });
    const r = await runUninstallHook({ scope: 'user', claudeHome, quiet: true });
    expect(r.removed).toBe(true);
    expect(r.noop).toBe(false);

    const s = await readSettings(join(claudeHome, 'settings.json'));
    // hooks.SessionStart cleaned up; hooks itself removed when empty.
    expect((s as { hooks?: unknown }).hooks).toBeUndefined();
  });

  it('preserves a --chain-ed foreign hook alongside ccpp', async () => {
    const settingsPath = join(claudeHome, 'settings.json');
    await fs.mkdir(claudeHome, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '*', hooks: [{ type: 'command', command: 'other-tool run' }] },
          ],
        },
      }),
    );
    await runInstallHook({ scope: 'user', claudeHome, ccppHome, chain: true, quiet: true });

    const r = await runUninstallHook({ scope: 'user', claudeHome, quiet: true });
    expect(r.removed).toBe(true);

    const s = await readSettings(settingsPath);
    const blocks = (s.hooks as { SessionStart: { hooks: { command: string }[] }[] }).SessionStart;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.hooks[0]!.command).toBe('other-tool run');
  });

  it('leaves unrelated hook categories intact', async () => {
    const settingsPath = join(claudeHome, 'settings.json');
    await fs.mkdir(claudeHome, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        model: 'sonnet',
        hooks: {
          UserPromptSubmit: [
            { matcher: '*', hooks: [{ type: 'command', command: 'other' }] },
          ],
        },
      }),
    );
    await runInstallHook({ scope: 'user', claudeHome, ccppHome, quiet: true });
    await runUninstallHook({ scope: 'user', claudeHome, quiet: true });

    const s = await readSettings(settingsPath);
    expect(s.model).toBe('sonnet');
    const hooks = s.hooks as Record<string, unknown>;
    expect(hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.SessionStart).toBeUndefined();
  });

  it('honours project scope', async () => {
    await runInstallHook({ scope: 'project', cwd, ccppHome, quiet: true });
    const settingsPath = join(cwd, '.claude', 'settings.json');
    expect(
      await fs.access(settingsPath).then(
        () => true,
        () => false,
      ),
    ).toBe(true);

    const r = await runUninstallHook({ scope: 'project', cwd, quiet: true });
    expect(r.removed).toBe(true);
    expect(r.settingsPath).toBe(settingsPath);
  });
});
