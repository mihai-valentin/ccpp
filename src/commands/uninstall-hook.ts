import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { dim, green, yellow } from '../lib/term.js';
import { type HookScope, isCcppBlock, settingsPathFor } from './install-hook.js';

export interface RunUninstallHookOpts {
  scope: HookScope;
  claudeHome?: string;
  cwd?: string;
  json?: boolean;
  quiet?: boolean;
}

export interface UninstallHookResult {
  settingsPath: string;
  removed: boolean;
  /** True if the settings file had no ccpp block to begin with (already clean). */
  noop: boolean;
}

interface HookCommand {
  type: 'command';
  command: string;
}

interface SessionStartBlock {
  matcher?: string;
  hooks: HookCommand[];
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: SessionStartBlock[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function readSettings(path: string): Promise<ClaudeSettings | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }
}

async function writeSettings(path: string, settings: ClaudeSettings): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export async function runUninstallHook(
  opts: RunUninstallHookOpts,
): Promise<UninstallHookResult> {
  const settingsPath = settingsPathFor({ scope: opts.scope, ...(opts.claudeHome !== undefined && { claudeHome: opts.claudeHome }), ...(opts.cwd !== undefined && { cwd: opts.cwd }) });
  const settings = await readSettings(settingsPath);

  const emit = (result: UninstallHookResult): UninstallHookResult => {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (!opts.quiet) {
      if (result.removed) {
        process.stdout.write(`${green('✓')} removed ccpp SessionStart hook from ${result.settingsPath}\n`);
      } else {
        process.stdout.write(`${yellow('!')} no ccpp hook found in ${result.settingsPath} ${dim('(already uninstalled)')}\n`);
      }
    }
    return result;
  };

  if (!settings) {
    return emit({ settingsPath, removed: false, noop: true });
  }

  const blocks = settings.hooks?.SessionStart;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return emit({ settingsPath, removed: false, noop: true });
  }

  const filtered = blocks.filter((b) => !isCcppBlock(b));
  if (filtered.length === blocks.length) {
    return emit({ settingsPath, removed: false, noop: true });
  }

  const hooks = settings.hooks!;
  if (filtered.length === 0) {
    delete hooks.SessionStart;
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  } else {
    hooks.SessionStart = filtered;
  }
  await writeSettings(settingsPath, settings);
  return emit({ settingsPath, removed: true, noop: false });
}
