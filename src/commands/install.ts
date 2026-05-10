import {
  type CcppConfig,
  type ConfigSource,
  POLICY_LATEST_WARNING,
  applyConfigSet,
  configExists,
  emptyConfig,
  readConfig,
  requiresAcknowledgement,
  writeConfig,
} from '../lib/config.js';
import { CollisionError, EnvError, UserError } from '../lib/errors.js';
import { cloneOrUpdate } from '../lib/git.js';
import { applyManifest } from '../lib/installer.js';
import { readLockfile, writeLockfile } from '../lib/lockfile.js';
import { parseManifest } from '../lib/manifest.js';
import {
  bold,
  dim,
  formatShortSha,
  green,
  isInteractive,
  promptChoice,
  promptLine,
  promptYesNo,
  yellow,
} from '../lib/term.js';
import type { Conflict } from '../lib/types.js';
import { type InstallHookResult, runInstallHook } from './install-hook.js';
import {
  type WizardIO,
  type WizardPlan,
  runInstallWizard,
  summarizeInstalledTargets,
} from './install-wizard.js';
import { type ResolvedCommon, log, resolveSourceUrlAndRef } from './shared.js';

/* -------------------- types -------------------- */

export interface InstallResult {
  installed: string[];
  updated: string[];
  unchanged: string[];
  conflicts: Conflict[];
  backups: string[];
}

export interface InstallSourceParams {
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

export interface InstallSourceOutcome {
  synced: Awaited<ReturnType<typeof cloneOrUpdate>>;
  result: InstallResult;
  /** The config object as it stands after this install — already written to disk unless scratch. */
  config: CcppConfig | null;
}

interface InstallFlags {
  ref?: string;
  prefer?: boolean;
  scratch?: boolean;
  preferLatest?: boolean;
  yes?: boolean;
}

export interface RunInstallOpts extends ResolvedCommon, InstallFlags {
  /** Source URL, optionally carrying an `@<ref>` shorthand. */
  rawUrl: string;
}

export type RunInstallInteractiveOpts = ResolvedCommon & InstallFlags;

/* -------------------- runInstall (URL-arg path) -------------------- */

/**
 * Handle `ccpp install <url>` — the explicit-URL form. Resolves any
 * `<url>@<ref>` shorthand against `--ref`, persists per-source policy
 * if `--prefer-latest` was passed, then runs the standard install pipeline.
 */
export async function runInstall(opts: RunInstallOpts): Promise<void> {
  if (opts.preferLatest === true && opts.scratch === true) {
    throw new UserError(
      'ccpp install: --prefer-latest writes per-source policy to ccpp.config.json and is incompatible with --scratch.',
    );
  }
  const { url, ref } = resolveSourceUrlAndRef(opts.rawUrl, opts.ref);

  let existing: CcppConfig | null = null;
  if (!opts.scratch) {
    try {
      existing = await readConfig(opts.configPath);
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
    common: opts,
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

  emitInstallSummary(url, synced.sha, synced.ref, result, opts);
}

/* -------------------- runInstallInteractive (no-URL wizard) -------------------- */

/**
 * Handle `ccpp install` with no URL. Runs the first-time setup wizard when a
 * config does not yet exist and stdin is a TTY; errors out otherwise with a
 * hint pointing at the non-interactive form.
 */
export async function runInstallInteractive(opts: RunInstallInteractiveOpts): Promise<void> {
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
  if (await configExists(opts.configPath)) {
    throw new UserError(
      `ccpp.config.json already exists at ${opts.configPath}. To add another source, run \`ccpp install <url>\`; to edit settings, use \`ccpp config\`.`,
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
  await writeConfig(opts.configPath, config);

  const installParams: InstallSourceParams = {
    url: plan.url,
    common: opts,
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
      claudeHome: opts.claudeHome,
      quiet: true,
    });
  }

  emitWizardReport({ plan, synced, result, hookResult, common: opts });
}

/* -------------------- installSource (shared by both paths) -------------------- */

/**
 * Clone the source, apply its manifest, and persist lockfile + config.
 * Shared between the URL-arg path and the wizard path so collision handling
 * and persistence order are identical. Exported so the collision-retry path
 * can be unit-tested in isolation.
 */
export async function installSource(params: InstallSourceParams): Promise<InstallSourceOutcome> {
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
  for (const w of manifest.warnings) {
    process.stderr.write(`${yellow('!')} ${w.message}\n`);
  }

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
  if (!scratch) {
    // Always persist a config on a non-scratch install — even if none
    // existed before. The previous behavior (writing only the lockfile
    // when no config existed) left the user in a state where the next
    // `ccpp sync` would error with "No ccpp.config.json".
    const config = existing ?? emptyConfig();
    if (!config.sources.some((s) => s.url === url)) {
      const src: ConfigSource = { url };
      if (ref) src.ref = ref;
      config.sources.push(src);
    }
    if (forcePreferIncoming || conflictsResolved) {
      config.preferredSources = preferredSources;
    }
    await writeConfig(common.configPath, config);
    finalConfig = config;
  }

  return { synced, result, config: finalConfig };
}

/* -------------------- helpers -------------------- */

/**
 * Persist `policy: latest` on the just-pushed source entry, gated by the
 * first-enable acknowledgement. `yes=true` auto-acks (as if the user typed
 * Y); otherwise, on a TTY the warning is printed and a [y/N] prompt fires,
 * and on a non-TTY we error out with a hint pointing at --yes.
 */
export async function applyPreferLatest(
  config: CcppConfig,
  url: string,
  yes: boolean,
): Promise<void> {
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

function realWizardIO(): WizardIO {
  return {
    out: (line: string) => process.stdout.write(`${line}\n`),
    promptLine: (message, o) => promptLine(message, o ?? {}),
    promptChoice: (message, choices, def) => promptChoice(message, choices, def),
    promptYesNo: (message) => promptYesNo(message),
  };
}

/**
 * Prompt the user to resolve each collision. For each conflict, offer:
 *   [1] keep the existing source's file
 *   [2] accept the incoming source's file
 *   [3] cancel the install
 * Returns a preferredSources map (conflict name → winning URL) or null if
 * the user cancelled.
 */
export async function interactiveConflictResolver(
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

export function formatCollisionMessage(
  conflicts: Conflict[],
  incomingSource: string | null,
): string {
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
    `${green('✓')} ${url} ${dim(`@${formatShortSha(sha)}`)} (${ref}) — ${result.installed.length} new, ${result.updated.length} updated, ${result.unchanged.length} unchanged`,
    common,
  );
  log(`  ${dim('config:')} ${common.configPath}`, common);
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
  log(
    `  ${green('✓')} ${plan.url} ${dim(`@${formatShortSha(synced.sha)} (${synced.ref})`)}`,
    common,
  );
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
