import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CONFIG_FILENAME } from '../lib/config.js';
import { UserError } from '../lib/errors.js';
import { LOCKFILE_FILENAME } from '../lib/lockfile.js';
import { disableColor } from '../lib/term.js';
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
