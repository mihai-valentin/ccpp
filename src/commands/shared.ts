import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { CONFIG_FILENAME } from '../lib/config.js';
import { UserError } from '../lib/errors.js';
import { LOCKFILE_FILENAME } from '../lib/lockfile.js';
import { disableColor, yellow } from '../lib/term.js';
import { splitUrlRef } from '../lib/url.js';

/**
 * Flags accepted by every subcommand. cac auto-camelCases hyphenated long
 * options, so `--claude-home` → `claudeHome`, etc.
 */
export interface CommonOpts {
  claudeHome?: string;
  config?: string;
  lockfile?: string;
  /** Force the project-scoped config (`./ccpp.config.json`) for write commands. */
  project?: boolean;
  json?: boolean;
  quiet?: boolean;
  noColor?: boolean;
}

/** Fully-resolved common state, ready to hand to a `runX` action. */
export interface ResolvedCommon {
  claudeHome: string;
  configPath: string;
  lockfilePath: string;
  json: boolean;
  quiet: boolean;
}

/**
 * Root for the user-scoped config + lockfile. `$CCPP_HOME` overrides for
 * tests and power users; otherwise `~/.ccpp/`.
 */
export function defaultUserCcppHome(): string {
  const env = process.env.CCPP_HOME;
  if (env && env.length > 0) return env;
  return join(homedir(), '.ccpp');
}

/**
 * Resolve where ccpp.config.json + ccpp.lock.json live for this run.
 *
 * Precedence:
 *   1. `--config <path>` (explicit, wins outright; lockfile is co-located unless `--lockfile <path>` is also passed).
 *   2. `--project` flag → `./ccpp.config.json`.
 *   3. `./ccpp.config.json` exists → use it (preserves the team-share workflow).
 *   4. Fallback to user-scoped `~/.ccpp/ccpp.config.json` (or `$CCPP_HOME/`).
 *
 * The user-scoped fallback is what makes the SessionStart hook work
 * regardless of which directory Claude Code launches from.
 */
export function commonPaths(opts: CommonOpts): ResolvedCommon {
  // Side effect: --no-color disables ANSI globally for the rest of the
  // process. Done here because every cli action calls commonPaths first;
  // factoring it out would mean every action remembering to call it.
  if (opts.noColor) disableColor();

  const projectConfigPath = resolve(process.cwd(), CONFIG_FILENAME);
  const userConfigPath = join(defaultUserCcppHome(), CONFIG_FILENAME);

  let configPath: string;
  if (opts.config) {
    configPath = resolve(opts.config);
  } else if (opts.project) {
    configPath = projectConfigPath;
  } else if (existsSync(projectConfigPath)) {
    configPath = projectConfigPath;
  } else {
    configPath = userConfigPath;
  }

  const lockfilePath = opts.lockfile
    ? resolve(opts.lockfile)
    : join(dirname(configPath), LOCKFILE_FILENAME);

  return {
    claudeHome: opts.claudeHome ? resolve(opts.claudeHome) : join(homedir(), '.claude'),
    configPath,
    lockfilePath,
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
  };
}

/** Write `line` to stdout unless `--quiet` is set. */
export function log(line: string, common: Pick<ResolvedCommon, 'quiet'>): void {
  if (!common.quiet) process.stdout.write(`${line}\n`);
}

/**
 * Returns a warning message when `claudeHome` lies under the OS tmpdir but
 * `lockfilePath` does not — the combination that creates dangling lockfile
 * entries pointing at `/tmp/...` destinations once the tmp dir is cleaned up.
 *
 * Caller is expected to write to stderr (not throw) — this is advisory, not
 * fatal. Returns null when the combination is safe (both under tmpdir, both
 * persistent, etc.).
 */
export function detectTransientClaudeHomeMismatch(
  claudeHome: string,
  lockfilePath: string,
): string | null {
  const tmp = tmpdir();
  const inTmp = (p: string) => p === tmp || p.startsWith(`${tmp}${sep}`);
  if (!inTmp(claudeHome) || inTmp(lockfilePath)) return null;
  return `${yellow('!')} --claude-home is in a tmpdir (${claudeHome}) but the lockfile is persistent (${lockfilePath}). The lockfile will record destinations that vanish once the tmp dir is cleaned. Consider passing --config and --lockfile under the same tmp tree, or set CCPP_HOME.`;
}

/**
 * Print {@link detectTransientClaudeHomeMismatch} to stderr if it triggers.
 * Accepts a loose shape so callers with their own opt struct (e.g. runSync)
 * don't need a {@link ResolvedCommon} to call it.
 */
export function warnIfTransientClaudeHome(opts: {
  claudeHome: string;
  lockfilePath: string;
}): void {
  const msg = detectTransientClaudeHomeMismatch(opts.claudeHome, opts.lockfilePath);
  if (msg !== null) process.stderr.write(`${msg}\n`);
}

/**
 * Reconcile a `<url>@<ref>` shorthand with an explicit `--ref` flag. Returns
 * the stripped URL and the effective ref. If the URL carries `@<ref>` and a
 * different `--ref` is passed, errors out — the two must agree (or only one
 * is supplied).
 */
export function resolveSourceUrlAndRef(
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
