import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cac } from 'cac';
import { type ConfigAction, runConfig } from './commands/config.js';
import { type HookScope, type InstallHookResult, runInstallHook } from './commands/install-hook.js';
import {
  type WizardIO,
  type WizardPlan,
  runInstallWizard,
  summarizeInstalledTargets,
} from './commands/install-wizard.js';
import { runStatus } from './commands/status.js';
import { resolveOverride, runSync } from './commands/sync.js';
import { runUninstallHook } from './commands/uninstall-hook.js';
import {
  type CcppConfig,
  type ConfigSource,
  POLICY_LATEST_WARNING,
  applyConfigSet,
  requiresAcknowledgement,
} from './lib/config.js';
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
import { splitUrlRef } from './lib/url.js';
import {
  bold,
  dim,
  disableColor,
  green,
  promptChoice,
  promptLine,
  promptYesNo,
  red,
  yellow,
} from './lib/term.js';
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

/**
 * Reconcile a `<url>@<ref>` shorthand with an explicit `--ref` flag. Returns
 * the stripped URL and the effective ref. If the URL carries `@<ref>` and a
 * different `--ref` is passed, errors out — the two must agree (or only one
 * is supplied).
 */
function resolveSourceUrlAndRef(
  rawUrl: string,
  flagRef: string | undefined,
): { url: string; ref: string | undefined } {
  const split = splitUrlRef(rawUrl);
  if (split.ref !== undefined && flagRef !== undefined && split.ref !== flagRef) {
    throw new UserError(
      `ccpp: ref conflict — URL specifies @${split.ref} but --ref ${flagRef} was passed. Pick one.`,
    );
  }
  return { url: split.url, ref: split.ref ?? flagRef };
}

function commonPaths(opts: CommonOpts): ResolvedCommon {
  if (opts.noColor) disableColor();
  return {
    claudeHome: opts.claudeHome ? resolve(opts.claudeHome) : join(homedir(), '.claude'),
    configPath: opts.config ? resolve(opts.config) : resolve(process.cwd(), CONFIG_FILENAME),
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

function attachCommonOptions<T extends { option: (flag: string, desc: string) => T }>(cmd: T): T {
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
  let resolved: { url: string; ref: string | undefined } | null = null;
  if (opts.source) {
    resolved = resolveSourceUrlAndRef(opts.source, opts.ref);
    const src: ConfigSource = { url: resolved.url };
    if (resolved.ref) src.ref = resolved.ref;
    config.sources.push(src);
  }
  await writeConfig(common.configPath, config);
  if (common.json) {
    process.stdout.write(`${JSON.stringify({ configPath: common.configPath, config })}\n`);
  } else {
    log(`${green('✓')} wrote ${common.configPath}`, common);
    if (resolved) {
      log(`  first source: ${resolved.url}${resolved.ref ? `@${resolved.ref}` : ''}`, common);
    } else {
      log(dim('  add sources with `ccpp install <url>`.'), common);
    }
  }
}

interface InstallResult {
  installed: string[];
  updated: string[];
  unchanged: string[];
  conflicts: Conflict[];
  backups: string[];
}

interface InstallSourceParams {
  url: string;
  ref?: string;
  common: ResolvedCommon;
  /** Existing parsed config (may be null on fresh install; never read if scratch). */
  existing: CcppConfig | null;
  /** If true, skip writing to ccpp.config.json. */
  scratch: boolean;
  /** When true, every conflict resolves in the incoming source's favour (CLI --prefer). */
  forcePreferIncoming: boolean;
  /**
   * Optional interactive fallback when conflicts arise and --prefer wasn't set.
   * Return a preferredSources map keyed by conflict name → winning source URL,
   * or null to abort (the caller will raise CollisionError).
   */
  resolveConflicts?: (
    conflicts: Conflict[],
    incomingUrl: string,
  ) => Promise<Record<string, string> | null>;
}

interface InstallSourceOutcome {
  synced: Awaited<ReturnType<typeof cloneOrUpdate>>;
  result: InstallResult;
  /** The config object as it stands after this install — already written to disk unless scratch. */
  config: CcppConfig | null;
}

/**
 * Clone the source, apply its manifest, and persist lockfile + config. Factored
 * out of `doInstall` so both the URL-arg path and the wizard path share a
 * single implementation (same collision handling, same persistence order).
 */
async function installSource(params: InstallSourceParams): Promise<InstallSourceOutcome> {
  const { url, ref, common, existing, scratch, forcePreferIncoming, resolveConflicts } = params;

  const cloneOpts: Parameters<typeof cloneOrUpdate>[1] = {};
  if (ref) cloneOpts.ref = ref;

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

  const preferredSources: Record<string, string> = existing?.preferredSources
    ? { ...existing.preferredSources }
    : {};

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

  let conflictsResolved = false;

  if (result.conflicts.length > 0 && forcePreferIncoming) {
    for (const c of result.conflicts) preferredSources[c.name] = url;
    conflictsResolved = true;
  } else if (result.conflicts.length > 0 && resolveConflicts) {
    const picked = await resolveConflicts(result.conflicts, url);
    if (picked === null) {
      await writeLockfile(common.lockfilePath, lockfile); // still record source pin
      throw new CollisionError(formatCollisionMessage(result.conflicts, url), result.conflicts);
    }
    Object.assign(preferredSources, picked);
    conflictsResolved = true;
  } else if (result.conflicts.length > 0) {
    await writeLockfile(common.lockfilePath, lockfile);
    throw new CollisionError(formatCollisionMessage(result.conflicts, url), result.conflicts);
  }

  if (conflictsResolved) {
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

  let finalConfig: CcppConfig | null = existing;
  if (existing && !scratch) {
    if (!existing.sources.some((s) => s.url === url)) {
      const src: ConfigSource = { url };
      if (ref) src.ref = ref;
      existing.sources.push(src);
    }
    if (forcePreferIncoming || conflictsResolved) {
      existing.preferredSources = preferredSources;
    }
    await writeConfig(common.configPath, existing);
    finalConfig = existing;
  }

  return { synced, result, config: finalConfig };
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
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    await doInstallInteractive(opts);
    return;
  }
  if (opts.preferLatest === true && opts.scratch === true) {
    throw new UserError(
      'ccpp install: --prefer-latest writes per-source policy to ccpp.config.json and is incompatible with --scratch.',
    );
  }
  const { url, ref } = resolveSourceUrlAndRef(rawUrl, opts.ref);
  const common = commonPaths(opts);

  let existing: CcppConfig | null = null;
  if (!opts.scratch) {
    try {
      existing = await readConfig(common.configPath);
    } catch (err) {
      throw new UserError((err as Error).message);
    }
  }

  if (opts.preferLatest === true) {
    if (existing === null) existing = emptyConfig();
    if (!existing.sources.some((s) => s.url === url)) {
      const src: ConfigSource = { url };
      if (ref) src.ref = ref;
      existing.sources.push(src);
    }
    await applyPreferLatest(existing, url, Boolean(opts.yes));
  }

  const installParams: InstallSourceParams = {
    url,
    common,
    existing,
    scratch: Boolean(opts.scratch),
    forcePreferIncoming: Boolean(opts.prefer) || Boolean(opts.yes),
  };
  if (ref) installParams.ref = ref;
  // Only offer interactive conflict resolution when stdin is a TTY and the
  // user did not pre-declare a winner via `--prefer` or `--yes`. Scripts keep
  // their old exit-3 behavior (CollisionError is thrown if no resolver picks).
  if (!opts.prefer && !opts.yes && isInteractive()) {
    installParams.resolveConflicts = (conflicts, incoming) =>
      interactiveConflictResolver(conflicts, incoming);
  }

  const { synced, result } = await installSource(installParams);

  emitInstallSummary(url, synced.sha, synced.ref, result, common);
}

/**
 * Persist `policy: latest` on the just-pushed source entry, gated by the
 * first-enable acknowledgement. `yes=true` auto-acks (as if the user typed
 * Y); otherwise, on a TTY the warning is printed and a [y/N] prompt fires,
 * and on a non-TTY we error out with a hint pointing at --yes.
 */
async function applyPreferLatest(config: CcppConfig, url: string, yes: boolean): Promise<void> {
  const key = `sources.${url}.policy`;
  const ackKind = requiresAcknowledgement(config, key, 'latest');
  if (ackKind !== null) process.stderr.write(`${POLICY_LATEST_WARNING}\n`);

  const setOpts: Parameters<typeof applyConfigSet>[3] = {};
  if (yes) {
    setOpts.autoAcceptAcks = true;
  } else if (ackKind === null) {
    // Ack already recorded — no confirm handler needed; applyConfigSet is a
    // straight write.
  } else if (isInteractive()) {
    setOpts.confirm = async () => await promptYesNo('Continue?');
  } else {
    throw new UserError(
      'ccpp install: --prefer-latest requires acknowledging the syncPolicy:latest risk. Add --yes to auto-confirm non-interactively.',
    );
  }
  try {
    await applyConfigSet(config, key, 'latest', setOpts);
  } catch (err) {
    throw new UserError((err as Error).message);
  }
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

function realWizardIO(): WizardIO {
  return {
    out: (line: string) => process.stdout.write(`${line}\n`),
    promptLine: (message, o) => promptLine(message, o ?? {}),
    promptChoice: (message, choices, def) => promptChoice(message, choices, def),
    promptYesNo: (message) => promptYesNo(message),
  };
}

/**
 * Handle `ccpp install` with no URL. Runs the first-time setup wizard when a
 * config does not yet exist and stdin is a TTY; errors out otherwise with a
 * hint pointing at the non-interactive form.
 */
async function doInstallInteractive(
  opts: CommonOpts & {
    ref?: string;
    prefer?: boolean;
    scratch?: boolean;
    preferLatest?: boolean;
    yes?: boolean;
  },
): Promise<void> {
  if (
    opts.ref !== undefined ||
    opts.prefer === true ||
    opts.scratch === true ||
    opts.preferLatest === true ||
    opts.yes === true
  ) {
    throw new UserError(
      'ccpp install: --ref, --prefer, --scratch, --prefer-latest and --yes all require a <url> argument.',
    );
  }
  const common = commonPaths(opts);
  if (await configExists(common.configPath)) {
    throw new UserError(
      `ccpp.config.json already exists at ${common.configPath}. To add another source, run \`ccpp install <url>\`; to edit settings, use \`ccpp config\`.`,
    );
  }
  if (!isInteractive()) {
    throw new UserError(
      'ccpp install: no <url> provided and stdin is not a TTY. Pass a URL: `ccpp install <url>`.',
    );
  }

  const io = realWizardIO();
  const plan = await runInstallWizard(io);
  if (plan === null) return;

  const config = emptyConfig();
  if (plan.syncPolicy !== 'pinned') {
    await applyConfigSet(config, 'syncPolicy', plan.syncPolicy, { autoAcceptAcks: true });
  }
  if (plan.autoAccept) {
    await applyConfigSet(config, 'autoAccept', 'true', { autoAcceptAcks: true });
  }
  const initialSrc: ConfigSource = { url: plan.url };
  if (plan.ref) initialSrc.ref = plan.ref;
  config.sources.push(initialSrc);
  await writeConfig(common.configPath, config);

  const installParams: InstallSourceParams = {
    url: plan.url,
    common,
    existing: config,
    scratch: false,
    forcePreferIncoming: false,
    resolveConflicts: (conflicts, incoming) => interactiveConflictResolver(conflicts, incoming),
  };
  if (plan.ref) installParams.ref = plan.ref;

  const { synced, result } = await installSource(installParams);

  let hookResult: InstallHookResult | null = null;
  if (plan.installHook) {
    hookResult = await runInstallHook({
      scope: 'user',
      claudeHome: common.claudeHome,
      quiet: true,
    });
  }

  emitWizardReport({ plan, synced, result, hookResult, common });
}

/**
 * Prompt the user to resolve each collision. For each conflict, offer:
 *   [1] keep the existing source's file
 *   [2] accept the incoming source's file
 *   [3] cancel the install
 * Returns a preferredSources map (conflict name → winning URL) or null if
 * the user cancelled.
 */
async function interactiveConflictResolver(
  conflicts: Conflict[],
  incomingUrl: string,
): Promise<Record<string, string> | null> {
  const picked: Record<string, string> = {};
  process.stderr.write(
    `\n${yellow('!')} ${conflicts.length} collision(s) detected with existing installed files.\n`,
  );
  for (const c of conflicts) {
    process.stderr.write(`\n  ${bold(c.name)}\n`);
    process.stderr.write(`    existing: ${dim(c.currentSourceUrl)}\n`);
    process.stderr.write(`    incoming: ${dim(c.incomingSourceUrl)}\n`);
    const choice = await promptChoice(
      '  keep existing, use incoming, or cancel?',
      ['keep', 'use-incoming', 'cancel'] as const,
      'keep',
    );
    if (choice === 'cancel') return null;
    picked[c.name] = choice === 'keep' ? c.currentSourceUrl : incomingUrl;
  }
  return picked;
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
  const table = [
    header,
    ...rows.map((r) => [r.name, r.type, r.sourceUrl, r.sha.slice(0, 7), r.lastSync]),
  ];
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
  type: 'command' | 'skill' | 'agent';
  sourceUrl: string;
  sha: string;
  lastSync: string;
  destPath: string;
}

function lockfileRows(lockfile: Lockfile, claudeHome: string): ListRow[] {
  const rows: ListRow[] = [];
  const commandsDir = join(claudeHome, 'commands');
  const skillsDir = join(claudeHome, 'skills');
  const agentsDir = join(claudeHome, 'agents');
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
    } else if (destPath.startsWith(`${agentsDir}`) && destPath.endsWith('.md')) {
      const name = destPath.slice(agentsDir.length + 1, -'.md'.length);
      rows.push({
        name,
        type: 'agent',
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
    lines.push(`  ${c.name}: ${c.currentSourceUrl} vs ${c.incomingSourceUrl}`);
  }
  if (incomingSource) {
    lines.push(`Resolve with: ccpp install ${incomingSource} --prefer   # makes this install win`);
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

interface WizardReportParams {
  plan: WizardPlan;
  synced: Awaited<ReturnType<typeof cloneOrUpdate>>;
  result: InstallResult;
  hookResult: InstallHookResult | null;
  common: ResolvedCommon;
}

/**
 * Post-wizard report: what landed on disk, effective config, hook status,
 * followed by a short "what's next" guide for the user's first sync.
 */
function emitWizardReport(params: WizardReportParams): void {
  const { plan, synced, result, hookResult, common } = params;
  if (common.json) {
    process.stdout.write(
      `${JSON.stringify({
        plan,
        url: plan.url,
        sha: synced.sha,
        ref: synced.ref,
        ...result,
        hook: hookResult,
      })}\n`,
    );
    return;
  }
  const { commandCount, skillNames, agentCount } = summarizeInstalledTargets(
    result,
    common.claudeHome,
  );

  log('', common);
  log(bold('Install complete'), common);
  log(`  ${green('✓')} ${plan.url} ${dim(`@${synced.sha.slice(0, 7)} (${synced.ref})`)}`, common);
  log(
    `    ${commandCount} command(s), ${skillNames.length} skill(s), ${agentCount} agent(s) in ${common.claudeHome}`,
    common,
  );
  log(
    `    ${dim(`${result.installed.length} new, ${result.updated.length} updated, ${result.unchanged.length} unchanged`)}`,
    common,
  );
  if (result.backups.length > 0) {
    log(`    ${yellow('!')} ${result.backups.length} file(s) backed up before overwrite`, common);
  }

  log('', common);
  log(bold('Config'), common);
  log(`  syncPolicy:  ${plan.syncPolicy}`, common);
  log(`  autoAccept:  ${plan.autoAccept}`, common);
  if (hookResult !== null) {
    log(`  hook:        ${green('installed')} ${dim(`→ ${hookResult.settingsPath}`)}`, common);
  } else {
    log(`  hook:        ${dim('not installed (run `ccpp install-hook` later to enable)')}`, common);
  }

  log('', common);
  log(bold("What's next"), common);
  log(
    `  ${dim('pull updates:')}       ccpp sync${plan.syncPolicy === 'pinned' ? ' --prefer-latest' : ''}`,
    common,
  );
  log(`  ${dim('see state:')}          ccpp status`, common);
  log(`  ${dim('add another source:')} ccpp install <url>`, common);
  log(`  ${dim('exit codes / docs:')}  docs/exit-codes.md`, common);
}

function stripColor(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping — \x1b is load-bearing.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function classifyAndExit(err: unknown): never {
  let code: number = EXIT.ENV;
  let message: string;
  if (err instanceof Error && typeof (err as { exitCode?: unknown }).exitCode === 'number') {
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
      .option('--ref <ref>', 'Optional ref (branch/tag/commit) for the first source (alternative to --source <url>@<ref> shorthand)')
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
      .option('--ref <ref>', 'Optional ref (branch/tag/commit) to check out (alternative to <url>@<ref> shorthand)')
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
