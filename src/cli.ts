import { cac } from 'cac';
import { type ConfigAction, runConfig } from './commands/config.js';
import { runInit } from './commands/init.js';
import { type HookScope, runInstallHook } from './commands/install-hook.js';
import { runInstall, runInstallInteractive } from './commands/install.js';
import { runList } from './commands/list.js';
import { type CommonOpts, commonPaths } from './commands/shared.js';
import { runStatus } from './commands/status.js';
import { resolveOverride, runSync } from './commands/sync.js';
import { runUninstallHook } from './commands/uninstall-hook.js';
import { runUninstall } from './commands/uninstall.js';
import { CONFIG_FILENAME } from './lib/config.js';
import { CollisionError, EXIT, EnvError, UserError } from './lib/errors.js';
import { LOCKFILE_FILENAME } from './lib/lockfile.js';
import { red } from './lib/term.js';

/**
 * Inlined at build time by tsup's `define`. The runtime never reads
 * package.json — no fs, no `__dirname`, works the same under CJS and ESM.
 * See tsup.config.ts for the source of truth.
 */
declare const __VERSION__: string;

function attachCommonOptions<T extends { option: (flag: string, desc: string) => T }>(cmd: T): T {
  cmd
    .option('--claude-home <path>', 'Override ~/.claude')
    .option(
      '--config <path>',
      `Override config-path resolution (default: ./${CONFIG_FILENAME} > ~/.ccpp/${CONFIG_FILENAME})`,
    )
    .option('--lockfile <path>', 'Override lockfile path (default: co-located with config)')
    .option(
      '--project',
      `Force project-scoped ./${CONFIG_FILENAME} (default for write commands is user-scoped ~/.ccpp/${CONFIG_FILENAME})`,
    )
    .option('--json', 'Emit machine-readable JSON instead of human output')
    .option('--quiet', 'Suppress non-error output')
    .option('--no-color', 'Disable ANSI color codes');
  return cmd;
}

/* -------------------- thin glue: cac action handlers → runX -------------------- */

async function doInit(
  opts: CommonOpts & { source?: string; ref?: string; force?: boolean },
): Promise<void> {
  const common = commonPaths(opts);
  const runOpts: Parameters<typeof runInit>[0] = { ...common };
  if (opts.source !== undefined) runOpts.source = opts.source;
  if (opts.ref !== undefined) runOpts.ref = opts.ref;
  if (opts.force === true) runOpts.force = true;
  await runInit(runOpts);
}

async function doInstall(
  rawUrl: string | undefined,
  opts: CommonOpts & {
    ref?: string;
    prefer?: boolean;
    scratch?: boolean;
    preferLatest?: boolean;
    yes?: boolean;
  },
): Promise<void> {
  const common = commonPaths(opts);
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    const interactiveOpts: Parameters<typeof runInstallInteractive>[0] = { ...common };
    if (opts.ref !== undefined) interactiveOpts.ref = opts.ref;
    if (opts.prefer === true) interactiveOpts.prefer = true;
    if (opts.scratch === true) interactiveOpts.scratch = true;
    if (opts.preferLatest === true) interactiveOpts.preferLatest = true;
    if (opts.yes === true) interactiveOpts.yes = true;
    await runInstallInteractive(interactiveOpts);
    return;
  }
  const installOpts: Parameters<typeof runInstall>[0] = { rawUrl, ...common };
  if (opts.ref !== undefined) installOpts.ref = opts.ref;
  if (opts.prefer === true) installOpts.prefer = true;
  if (opts.scratch === true) installOpts.scratch = true;
  if (opts.preferLatest === true) installOpts.preferLatest = true;
  if (opts.yes === true) installOpts.yes = true;
  await runInstall(installOpts);
}

async function doSync(
  opts: CommonOpts & {
    update?: boolean;
    preferLatest?: boolean;
    pinned?: boolean;
    autoAccept?: boolean;
    verbose?: boolean;
    trigger?: string;
  },
): Promise<void> {
  const common = commonPaths(opts);
  const override = resolveOverride({
    preferLatest: opts.preferLatest,
    pinned: opts.pinned,
    update: opts.update,
  });
  const runOpts: Parameters<typeof runSync>[0] = {
    configPath: common.configPath,
    lockfilePath: common.lockfilePath,
    claudeHome: common.claudeHome,
    json: common.json,
    quiet: common.quiet,
  };
  if (override !== undefined) runOpts.override = override;
  if (opts.autoAccept === true) runOpts.autoAccept = true;
  if (opts.verbose === true) runOpts.verbose = true;
  if (opts.trigger !== undefined) {
    if (opts.trigger !== 'manual' && opts.trigger !== 'hook') {
      throw new UserError(
        `ccpp sync: --trigger must be 'manual' or 'hook' (got ${JSON.stringify(opts.trigger)}).`,
      );
    }
    runOpts.trigger = opts.trigger;
  }
  await runSync(runOpts);
}

async function doInstallHook(
  opts: CommonOpts & { project?: boolean; chain?: boolean; force?: boolean },
): Promise<void> {
  const common = commonPaths(opts);
  const scope: HookScope = opts.project === true ? 'project' : 'user';
  const runOpts: Parameters<typeof runInstallHook>[0] = {
    scope,
    claudeHome: common.claudeHome,
    json: common.json,
    quiet: common.quiet,
  };
  if (opts.chain === true) runOpts.chain = true;
  if (opts.force === true) runOpts.force = true;
  await runInstallHook(runOpts);
}

async function doUninstallHook(opts: CommonOpts & { project?: boolean }): Promise<void> {
  const common = commonPaths(opts);
  const scope: HookScope = opts.project === true ? 'project' : 'user';
  await runUninstallHook({
    scope,
    claudeHome: common.claudeHome,
    json: common.json,
    quiet: common.quiet,
  });
}

async function doStatus(opts: CommonOpts): Promise<void> {
  const common = commonPaths(opts);
  await runStatus({
    configPath: common.configPath,
    lockfilePath: common.lockfilePath,
    json: common.json,
    quiet: common.quiet,
  });
}

async function doList(opts: CommonOpts): Promise<void> {
  await runList(commonPaths(opts));
}

async function doUninstall(name: string, opts: CommonOpts): Promise<void> {
  await runUninstall({ name, ...commonPaths(opts) });
}

async function doConfig(
  action: string,
  key: string | undefined,
  value: string | undefined,
  opts: CommonOpts & { autoAccept?: boolean },
): Promise<void> {
  const common = commonPaths(opts);
  const valid: ConfigAction[] = ['get', 'set', 'reset', 'list'];
  if (!valid.includes(action as ConfigAction)) {
    throw new UserError(
      `ccpp config: unknown action "${action}". Expected one of ${valid.join(', ')}.`,
    );
  }
  try {
    const runOpts: Parameters<typeof runConfig>[0] = {
      action: action as ConfigAction,
      configPath: common.configPath,
      json: common.json,
      quiet: common.quiet,
    };
    if (key !== undefined) runOpts.key = key;
    if (value !== undefined) runOpts.value = value;
    if (opts.autoAccept === true) runOpts.autoAccept = true;
    await runConfig(runOpts);
  } catch (err) {
    throw new UserError((err as Error).message);
  }
}

/* -------------------- error classifier + main -------------------- */

function classifyAndExit(err: unknown): never {
  let code: number = EXIT.ENV;
  let message: string;
  if (err instanceof UserError || err instanceof EnvError || err instanceof CollisionError) {
    code = err.exitCode;
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
    if (/^missing required args/i.test(message) || /^unknown option/i.test(message)) {
      code = EXIT.USER;
    }
  } else {
    message = String(err);
  }
  process.stderr.write(`${red('✗')} ${message}\n`);
  process.exit(code);
}

async function main(argv: string[]): Promise<void> {
  const cli = cac('ccpp');
  const version = __VERSION__;

  attachCommonOptions(
    cli
      .command('init', 'Create a ccpp.config.json in the current directory')
      .option('--source <url>', 'First source URL to record in the config')
      .option(
        '--ref <ref>',
        'Optional ref (branch/tag/commit) for the first source (alternative to --source <url>@<ref> shorthand)',
      )
      .option('--force', 'Overwrite an existing config')
      .action(async (opts: CommonOpts & { source?: string; ref?: string; force?: boolean }) => {
        await doInit(opts);
      }),
  );

  attachCommonOptions(
    cli
      .command(
        'install [url]',
        'Clone a source and install it; no <url> → first-time interactive wizard. URL accepts <url>@<ref> shorthand.',
      )
      .option(
        '--ref <ref>',
        'Optional ref (branch/tag/commit) to check out (alternative to <url>@<ref> shorthand)',
      )
      .option('--prefer', 'On collision, prefer this install over existing lockfile entries')
      .option('--prefer-latest', 'Persist policy=latest on this source (future syncs pull newest)')
      .option('--yes', 'Auto-confirm prompts during this install run (ack + collisions)')
      .option('--scratch', 'Ad-hoc install — do not touch ccpp.config.json')
      .action(
        async (
          url: string | undefined,
          opts: CommonOpts & {
            ref?: string;
            prefer?: boolean;
            scratch?: boolean;
            preferLatest?: boolean;
            yes?: boolean;
          },
        ) => {
          await doInstall(url, opts);
        },
      ),
  );

  attachCommonOptions(
    cli
      .command('sync', 'Sync every source in ccpp.config.json to its pinned / latest commit')
      .option('--prefer-latest', 'One-shot: treat every source as policy=latest for this run')
      .option('--pinned', 'One-shot: treat every source as policy=pinned for this run')
      .option('--update', 'Deprecated alias for --prefer-latest')
      .option('--auto-accept', 'Skip the diff-preview prompt for this run')
      .option('--verbose', 'Expand the diff-preview summary to per-file paths')
      .option(
        '--trigger <kind>',
        '(internal) Tag log entries with manual|hook — used by the SessionStart hook',
      )
      .action(
        async (
          opts: CommonOpts & {
            update?: boolean;
            preferLatest?: boolean;
            pinned?: boolean;
            autoAccept?: boolean;
            verbose?: boolean;
            trigger?: string;
          },
        ) => {
          await doSync(opts);
        },
      ),
  );

  attachCommonOptions(
    cli
      .command('list', 'List commands, skills, and agents currently installed')
      .action(async (opts: CommonOpts) => {
        await doList(opts);
      }),
  );

  attachCommonOptions(
    cli
      .command('uninstall <name>', 'Uninstall a source (by URL or repo name)')
      .action(async (name: string, opts: CommonOpts) => {
        await doUninstall(name, opts);
      }),
  );

  attachCommonOptions(
    cli
      .command(
        'install-hook',
        'Install the Claude Code SessionStart hook (runs `ccpp sync` at session start)',
      )
      .option('--project', 'Write to ./.claude/settings.json instead of user scope')
      .option('--chain', 'Append ccpp after an existing SessionStart hook')
      .option('--force', 'Replace any existing SessionStart hooks with ccpp')
      .action(
        async (opts: CommonOpts & { project?: boolean; chain?: boolean; force?: boolean }) => {
          await doInstallHook(opts);
        },
      ),
  );

  attachCommonOptions(
    cli
      .command('uninstall-hook', "Remove ccpp's SessionStart hook entry from settings.json")
      .option('--project', 'Target ./.claude/settings.json instead of user scope')
      .action(async (opts: CommonOpts & { project?: boolean }) => {
        await doUninstallHook(opts);
      }),
  );

  attachCommonOptions(
    cli
      .command('status', 'Show per-source sync state and recent log entries')
      .action(async (opts: CommonOpts) => {
        await doStatus(opts);
      }),
  );

  attachCommonOptions(
    cli
      .command('config <action> [key] [value]', 'Manage ccpp configuration')
      .option(
        '--auto-accept',
        'On `set`, skip the first-enable warning and record the acknowledgement',
      )
      .action(
        async (
          action: string,
          key: string | undefined,
          value: string | undefined,
          opts: CommonOpts & { autoAccept?: boolean },
        ) => {
          await doConfig(action, key, value, opts);
        },
      ),
  );

  // cac convention: an empty command name is the catch-all for `ccpp` with
  // no subcommand. Without this, bare `ccpp` exits silently instead of
  // showing help.
  cli.command('', 'Show help').action(() => {
    cli.outputHelp();
  });

  cli.help();
  cli.version(version);

  cli.help((sections) => {
    sections.push({
      title: 'Exit codes',
      body: [
        '  0  success',
        '  1  user error (bad args, missing config, invalid ccpp.config.json)',
        '  2  environment error (git clone/fetch failed, manifest parse failed, permission denied)',
        '  3  collision requiring user input (re-run with --prefer or add preferredSources to config)',
      ].join('\n'),
    });
    return sections;
  });

  cli.parse(argv, { run: false });
  await cli.runMatchedCommand();
}

main(process.argv).catch(classifyAndExit);
