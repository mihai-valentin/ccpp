import {
  type AckKind,
  CONFIG_FILENAME,
  type CcppConfig,
  applyConfigSet,
  configExists,
  emptyConfig,
  getConfigValue,
  listConfig,
  readConfig,
  requiresAcknowledgement,
  resetConfigValue,
  writeConfig,
} from '../lib/config.js';
import { dim, green, promptYesNo } from '../lib/term.js';

export type ConfigAction = 'get' | 'set' | 'reset' | 'list';

export interface RunConfigOpts {
  action: ConfigAction;
  key?: string;
  value?: string;
  configPath: string;
  json: boolean;
  quiet: boolean;
  /** `--auto-accept` on `config set`: skip first-enable prompt and record ack. */
  autoAccept?: boolean;
}

/**
 * Errors originating from this module are plain `Error`s with a human-readable
 * message; the CLI layer wraps them into `UserError` (exit 1) before exit.
 */
export async function runConfig(opts: RunConfigOpts): Promise<void> {
  const config = await loadOrEmptyConfig(opts.configPath);

  switch (opts.action) {
    case 'list':
      return emitList(config, opts);
    case 'get': {
      if (!opts.key) throw new Error('ccpp config get: missing <key> argument');
      return emitGet(config, opts.key, opts);
    }
    case 'set': {
      if (!opts.key) throw new Error('ccpp config set: missing <key> argument');
      if (opts.value === undefined) {
        throw new Error('ccpp config set: missing <value> argument');
      }
      const ackKind = requiresAcknowledgement(config, opts.key, opts.value);
      if (ackKind !== null && opts.autoAccept !== true && !process.stdin.isTTY) {
        throw new Error(
          `set ${opts.key} requires confirmation; pass --auto-accept or run from an interactive terminal.`,
        );
      }
      const setOpts: Parameters<typeof applyConfigSet>[3] = {};
      if (opts.autoAccept === true) {
        setOpts.autoAcceptAcks = true;
      } else if (ackKind !== null) {
        setOpts.confirm = (_kind: AckKind, message: string) => promptYesNo(message);
      }
      await applyConfigSet(config, opts.key, opts.value, setOpts);
      await writeConfig(opts.configPath, config);
      return emitSet(config, opts.key, opts);
    }
    case 'reset': {
      resetConfigValue(config, opts.key);
      await writeConfig(opts.configPath, config);
      return emitReset(opts);
    }
  }
}

async function loadOrEmptyConfig(path: string): Promise<CcppConfig> {
  if (!(await configExists(path))) return emptyConfig();
  const config = await readConfig(path);
  return config ?? emptyConfig();
}

function emitList(config: CcppConfig, opts: RunConfigOpts): void {
  const rows = listConfig(config);
  if (opts.json) {
    const flat: Record<string, unknown> = {};
    for (const r of rows) flat[r.key] = r.value;
    process.stdout.write(`${JSON.stringify(flat)}\n`);
    return;
  }
  if (opts.quiet) return;
  const keyWidth = Math.max(...rows.map((r) => r.key.length), 0);
  for (const r of rows) {
    const valueStr = formatValue(r.value);
    const suffix = r.isDefault ? dim(' (default)') : '';
    process.stdout.write(`${r.key.padEnd(keyWidth)}  ${valueStr}${suffix}\n`);
  }
}

function emitGet(config: CcppConfig, key: string, opts: RunConfigOpts): void {
  const value = getConfigValue(config, key);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ key, value: value ?? null })}\n`);
    return;
  }
  if (value === undefined) {
    process.stdout.write(`${formatValue(value, { dim: true })}\n`);
    return;
  }
  process.stdout.write(`${formatValue(value)}\n`);
}

function emitSet(config: CcppConfig, key: string, opts: RunConfigOpts): void {
  const effective = getConfigValue(config, key);
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ key, value: effective ?? null, configPath: opts.configPath })}\n`,
    );
    return;
  }
  if (opts.quiet) return;
  process.stdout.write(`${green('✓')} ${key} = ${formatValue(effective)}\n`);
}

function emitReset(opts: RunConfigOpts): void {
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ reset: opts.key ?? null, configPath: opts.configPath })}\n`,
    );
    return;
  }
  if (opts.quiet) return;
  if (opts.key) {
    process.stdout.write(`${green('✓')} reset ${opts.key}\n`);
  } else {
    process.stdout.write(`${green('✓')} reset all v0.1.1 policy fields to defaults\n`);
  }
}

function formatValue(value: unknown, opts: { dim?: boolean } = {}): string {
  if (value === undefined || value === null) {
    return opts.dim === true ? dim('(unset)') : '(unset)';
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// Expose the filename constant for CLI use alongside the default config path.
export { CONFIG_FILENAME };
