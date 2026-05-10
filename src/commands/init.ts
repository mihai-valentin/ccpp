import { type ConfigSource, configExists, emptyConfig, writeConfig } from '../lib/config.js';
import { UserError } from '../lib/errors.js';
import { dim, green } from '../lib/term.js';
import { type ResolvedCommon, log, resolveSourceUrlAndRef } from './shared.js';

export interface RunInitOpts extends ResolvedCommon {
  /** Optional source URL to seed `sources[0]`. May carry an `@<ref>` shorthand. */
  source?: string;
  /** Optional explicit ref. Errors if it conflicts with an `@<ref>` in `source`. */
  ref?: string;
  /** Overwrite an existing config at `configPath`. Without this, the call errors out. */
  force?: boolean;
}

/**
 * Create a fresh `ccpp.config.json` at the resolved configPath. Optionally
 * seed it with a single source from `--source` (and optional `--ref`).
 */
export async function runInit(opts: RunInitOpts): Promise<void> {
  if ((await configExists(opts.configPath)) && !opts.force) {
    throw new UserError(
      `Refusing to overwrite existing ${opts.configPath}. Re-run with --force to replace it.`,
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
  await writeConfig(opts.configPath, config);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ configPath: opts.configPath, config })}\n`);
  } else {
    log(`${green('✓')} wrote ${opts.configPath}`, opts);
    if (resolved) {
      log(`  first source: ${resolved.url}${resolved.ref ? `@${resolved.ref}` : ''}`, opts);
    } else {
      log(dim('  add sources with `ccpp install <url>`.'), opts);
    }
  }
}
