import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cac } from 'cac';
import { type ConfigAction, runConfig } from './commands/config.js';
import { resolveOverride, runSync } from './commands/sync.js';
import type { CcppConfig, ConfigSource } from './lib/config.js';
import {
  CONFIG_FILENAME,
  configExists,
  emptyConfig,
  readConfig,
  writeConfig,
} from './lib/config.js';
import { cloneOrUpdate, parseRepoUrl } from './lib/git.js';
import { applyManifest, removeFromLockfile } from './lib/installer.js';
import { LOCKFILE_FILENAME, readLockfile, writeLockfile } from './lib/lockfile.js';
import { parseManifest } from './lib/manifest.js';
import { bold, dim, disableColor, green, red, yellow } from './lib/term.js';
import type { Conflict, Lockfile } from './lib/types.js';

/** Exit codes — also documented in `ccpp --help` epilog and docs/exit-codes.md. */
const EXIT = { OK: 0, USER: 1, ENV: 2, COLLISION: 3 } as const;

class UserError extends Error {
  readonly exitCode = EXIT.USER;
}
class EnvError extends Error {
  readonly exitCode = EXIT.ENV;
}
class CollisionError extends Error {
  readonly exitCode = EXIT.COLLISION;
  readonly conflicts: Conflict[];
  constructor(message: string, conflicts: Conflict[]) {
    super(message);
    this.conflicts = conflicts;
  }
}

interface CommonOpts {
  claudeHome?: string;
  config?: string;
  lockfile?: string;
  json?: boolean;
  quiet?: boolean;
  noColor?: boolean;
}

interface ResolvedCommon {
  claudeHome: string;
  configPath: string;
  lockfilePath: string;
  json: boolean;
  quiet: boolean;
}

function commonPaths(opts: CommonOpts): ResolvedCommon {
  if (opts.noColor) disableColor();
  return {
    claudeHome: opts.claudeHome ? resolve(opts.claudeHome) : join(homedir(), '.claude'),
    configPath: opts.config
      ? resolve(opts.config)
      : resolve(process.cwd(), CONFIG_FILENAME),
    lockfilePath: opts.lockfile
      ? resolve(opts.lockfile)
      : resolve(process.cwd(), LOCKFILE_FILENAME),
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
  };
}

function log(line: string, common: Pick<ResolvedCommon, 'quiet'>): void {
  if (!common.quiet) process.stdout.write(`${line}\n`);
}

function readPkgVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function attachCommonOptions<T extends { option: (flag: string, desc: string) => T }>(
  cmd: T,
): T {
  cmd
    .option('--claude-home <path>', 'Override ~/.claude')
    .option('--config <path>', `Override ./${CONFIG_FILENAME}`)
    .option('--lockfile <path>', `Override ./${LOCKFILE_FILENAME}`)
    .option('--json', 'Emit machine-readable JSON instead of human output')
    .option('--quiet', 'Suppress non-error output')
    .option('--no-color', 'Disable ANSI color codes');
  return cmd;
}

async function doInit(
  opts: CommonOpts & { source?: string; ref?: string; force?: boolean },
): Promise<void> {
  const common = commonPaths(opts);
  if ((await configExists(common.configPath)) && !opts.force) {
    throw new UserError(
      `Refusing to overwrite existing ${common.configPath}. Re-run with --force to replace it.`,
    );
  }
  const config = emptyConfig();
  if (opts.source) {
    const src: ConfigSource = { url: opts.source };
    if (opts.ref) src.ref = opts.ref;
    config.sources.push(src);
  }
  await writeConfig(common.configPath, config);
  if (common.json) {
    process.stdout.write(`${JSON.stringify({ configPath: common.configPath, config })}\n`);
  } else {
    log(green('✓') + ` wrote ${common.configPath}`, common);
    if (opts.source) {
      log(`  first source: ${opts.source}${opts.ref ? `@${opts.ref}` : ''}`, common);
    } else {
      log(dim('  add sources with `ccpp install <url>`.'), common);
    }
  }
}

async function doInstall(
  url: string,
  opts: CommonOpts & { ref?: string; prefer?: boolean; scratch?: boolean },
): Promise<void> {
  if (typeof url !== 'string' || url.length === 0) {
    throw new UserError('ccpp install: missing <url> argument');
  }
  const common = commonPaths(opts);

  let existing: CcppConfig | null = null;
  if (!opts.scratch) {
    try {
      existing = await readConfig(common.configPath);
    } catch (err) {
      throw new UserError((err as Error).message);
    }
  }

  const cloneOpts: Parameters<typeof cloneOrUpdate>[1] = {};
  if (opts.ref) cloneOpts.ref = opts.ref;

  let synced: Awaited<ReturnType<typeof cloneOrUpdate>>;
  try {
    synced = await cloneOrUpdate(url, cloneOpts);
  } catch (err) {
    throw new EnvError((err as Error).message);
  }

  const manifest = await parseManifest(synced.localPath).catch((err: Error) => {
    throw new EnvError(err.message);
  });

  const lockfile = await readLockfile(common.lockfilePath).catch((err: Error) => {
    throw new UserError(err.message);
  });

  const preferredSources: Record<string, string> =
    existing?.preferredSources ? { ...existing.preferredSources } : {};

  const result = await applyManifest({
    manifest,
    sourceUrl: url,
    sourceSha: synced.sha,
    claudeHome: common.claudeHome,
    lockfile,
    preferredSources,
  });

  lockfile.sources[url] = {
    sha: synced.sha,
    ref: synced.ref,
    lastSync: new Date().toISOString(),
  };

  if (result.conflicts.length > 0 && !opts.prefer) {
    await writeLockfile(common.lockfilePath, lockfile); // still record source pin so state is consistent
    throw new CollisionError(formatCollisionMessage(result.conflicts, url), result.conflicts);
  }

  if (result.conflicts.length > 0 && opts.prefer) {
    // User opted in to "this install wins for its conflicts" — replay with preferences set.
    for (const c of result.conflicts) preferredSources[c.name] = url;
    const retry = await applyManifest({
      manifest,
      sourceUrl: url,
      sourceSha: synced.sha,
      claudeHome: common.claudeHome,
      lockfile,
      preferredSources,
    });
    result.installed.push(...retry.installed);
    result.updated.push(...retry.updated);
    result.unchanged.push(...retry.unchanged);
    result.backups.push(...retry.backups);
    result.conflicts = retry.conflicts;
  }

  await writeLockfile(common.lockfilePath, lockfile);

  if (existing && !opts.scratch) {
    if (!existing.sources.some((s) => s.url === url)) {
      const src: ConfigSource = { url };
      if (opts.ref) src.ref = opts.ref;
      existing.sources.push(src);
    }
    if (opts.prefer) {
      existing.preferredSources = preferredSources;
    }
    await writeConfig(common.configPath, existing);
  }

  emitInstallSummary(url, synced.sha, synced.ref, result, common);
}

async function doSync(
  opts: CommonOpts & { update?: boolean; preferLatest?: boolean; pinned?: boolean },
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
  await runSync(runOpts);
}

async function doList(opts: CommonOpts): Promise<void> {
  const common = commonPaths(opts);
  const lockfile = await readLockfile(common.lockfilePath).catch((err: Error) => {
    throw new UserError(err.message);
  });
  const rows = lockfileRows(lockfile, common.claudeHome);

  if (common.json) {
    process.stdout.write(`${JSON.stringify({ rows })}\n`);
    return;
  }

  if (rows.length === 0) {
    log(dim('(nothing installed)'), common);
    return;
  }

  const header = [bold('NAME'), bold('TYPE'), bold('SOURCE'), bold('SHA'), bold('LAST_SYNC')];
  const table = [header, ...rows.map((r) => [r.name, r.type, r.sourceUrl, r.sha.slice(0, 7), r.lastSync])];
  const widths = table[0]!.map((_, i) =>
    Math.max(...table.map((row) => stripColor(row[i] ?? '').length)),
  );
  for (const row of table) {
    log(
      row
        .map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i]! - stripColor(cell).length)))
        .join('  '),
      common,
    );
  }
}

async function doUninstall(name: string, opts: CommonOpts): Promise<void> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new UserError('ccpp uninstall: missing <name> argument');
  }
  const common = commonPaths(opts);
  const lockfile = await readLockfile(common.lockfilePath).catch((err: Error) => {
    throw new UserError(err.message);
  });

  const target = resolveSourceForUninstall(lockfile, name);
  if (!target) {
    throw new UserError(
      `No installed source matches "${name}". Try \`ccpp list\` to see installed sources.`,
    );
  }

  const result = await removeFromLockfile({
    name: target,
    claudeHome: common.claudeHome,
    lockfile,
  });

  // Also drop from config.sources if present.
  const config = await readConfig(common.configPath).catch(() => null);
  if (config) {
    const before = config.sources.length;
    config.sources = config.sources.filter((s) => s.url !== target);
    if (config.sources.length !== before) {
      await writeConfig(common.configPath, config);
    }
  }

  await writeLockfile(common.lockfilePath, lockfile);

  if (common.json) {
    process.stdout.write(`${JSON.stringify({ source: target, ...result })}\n`);
    return;
  }
  log(
    `${green('✓')} uninstalled ${target} — ${result.removed.length} file(s) removed, ${result.backups.length} backup(s) kept`,
    common,
  );
  for (const bak of result.backups) log(`  ${dim(bak)}`, common);
}

async function doConfig(
  action: string,
  key: string | undefined,
  value: string | undefined,
  opts: CommonOpts,
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
    await runConfig(runOpts);
  } catch (err) {
    throw new UserError((err as Error).message);
  }
}

function resolveSourceForUninstall(lockfile: Lockfile, name: string): string | null {
  if (lockfile.sources[name]) return name;
  for (const url of Object.keys(lockfile.sources)) {
    try {
      const { repo } = parseRepoUrl(url);
      if (repo === name) return url;
    } catch {
      // ignore parse failures — fall through to the next source
    }
  }
  // Fallback: match against any installed entry's sourceUrl
  for (const entry of Object.values(lockfile.installed)) {
    if (entry.sourceUrl === name) return entry.sourceUrl;
  }
  return null;
}

interface ListRow {
  name: string;
  type: 'command' | 'skill';
  sourceUrl: string;
  sha: string;
  lastSync: string;
  destPath: string;
}

function lockfileRows(lockfile: Lockfile, claudeHome: string): ListRow[] {
  const rows: ListRow[] = [];
  const commandsDir = join(claudeHome, 'commands');
  const skillsDir = join(claudeHome, 'skills');
  const seenSkills = new Set<string>();
  for (const [destPath, entry] of Object.entries(lockfile.installed)) {
    if (destPath.startsWith(`${commandsDir}`) && destPath.endsWith('.md')) {
      const name = destPath.slice(commandsDir.length + 1, -'.md'.length);
      rows.push({
        name,
        type: 'command',
        sourceUrl: entry.sourceUrl,
        sha: entry.sourceSha,
        lastSync: entry.installedAt,
        destPath,
      });
    } else if (destPath.startsWith(`${skillsDir}`)) {
      const rest = destPath.slice(skillsDir.length + 1);
      const skillName = rest.split(/[\\/]/)[0]!;
      const key = `${entry.sourceUrl}::${skillName}`;
      if (seenSkills.has(key)) continue;
      seenSkills.add(key);
      rows.push({
        name: skillName,
        type: 'skill',
        sourceUrl: entry.sourceUrl,
        sha: entry.sourceSha,
        lastSync: entry.installedAt,
        destPath: join(skillsDir, skillName),
      });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  return rows;
}

function formatCollisionMessage(conflicts: Conflict[], incomingSource: string | null): string {
  const lines = [`${conflicts.length} collision(s) unresolved:`];
  for (const c of conflicts) {
    lines.push(
      `  ${c.name}: ${c.currentSourceUrl} vs ${c.incomingSourceUrl}`,
    );
  }
  if (incomingSource) {
    lines.push(
      `Resolve with: ccpp install ${incomingSource} --prefer   # makes this install win`,
    );
  } else {
    lines.push(
      'Resolve by adding `preferredSources` entries to ccpp.config.json, then re-running sync.',
    );
  }
  return lines.join('\n');
}

function emitInstallSummary(
  url: string,
  sha: string,
  ref: string,
  result: {
    installed: string[];
    updated: string[];
    unchanged: string[];
    conflicts: Conflict[];
    backups: string[];
  },
  common: ResolvedCommon,
): void {
  if (common.json) {
    process.stdout.write(`${JSON.stringify({ url, sha, ref, ...result })}\n`);
    return;
  }
  log(
    `${green('✓')} ${url} ${dim(`@${sha.slice(0, 7)}`)} (${ref}) — ${result.installed.length} new, ${result.updated.length} updated, ${result.unchanged.length} unchanged`,
    common,
  );
  if (result.backups.length > 0) {
    log(`  ${yellow('!')} ${result.backups.length} file(s) backed up:`, common);
    for (const bak of result.backups) log(`    ${dim(bak)}`, common);
  }
}

function stripColor(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function classifyAndExit(err: unknown): never {
  let code: number = EXIT.ENV;
  let message: string;
  if (
    err instanceof Error &&
    typeof (err as { exitCode?: unknown }).exitCode === 'number'
  ) {
    // Duck-typed: recognizes error classes defined in sub-modules (e.g. commands/sync.ts)
    // without requiring a shared base class across module boundaries.
    code = (err as unknown as { exitCode: number }).exitCode;
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
  const version = readPkgVersion();

  attachCommonOptions(
    cli
      .command('init', 'Create a ccpp.config.json in the current directory')
      .option('--source <url>', 'First source URL to record in the config')
      .option('--ref <ref>', 'Optional ref (branch/tag) for the first source')
      .option('--force', 'Overwrite an existing config')
      .action(async (opts: CommonOpts & { source?: string; ref?: string; force?: boolean }) => {
        await doInit(opts);
      }),
  );

  attachCommonOptions(
    cli
      .command('install <url>', 'Clone a source, install its plugins, and update the lockfile')
      .option('--ref <ref>', 'Optional ref (branch/tag) to check out')
      .option('--prefer', 'On collision, prefer this install over existing lockfile entries')
      .option('--scratch', 'Ad-hoc install — do not touch ccpp.config.json')
      .action(
        async (url: string, opts: CommonOpts & { ref?: string; prefer?: boolean; scratch?: boolean }) => {
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
      .action(
        async (
          opts: CommonOpts & { update?: boolean; preferLatest?: boolean; pinned?: boolean },
        ) => {
          await doSync(opts);
        },
      ),
  );

  attachCommonOptions(
    cli.command('list', 'List commands and skills currently installed').action(async (opts: CommonOpts) => {
      await doList(opts);
    }),
  );

  attachCommonOptions(
    cli.command('uninstall <name>', 'Uninstall a source (by URL or repo name)').action(
      async (name: string, opts: CommonOpts) => {
        await doUninstall(name, opts);
      },
    ),
  );

  attachCommonOptions(
    cli
      .command('config <action> [key] [value]', 'Manage ccpp configuration')
      .action(
        async (
          action: string,
          key: string | undefined,
          value: string | undefined,
          opts: CommonOpts,
        ) => {
          await doConfig(action, key, value, opts);
        },
      ),
  );

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
