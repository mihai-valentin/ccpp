import {
  CONFIG_FILENAME,
  type CcppConfig,
  type ConfigSource,
  readConfig,
  type SyncPolicy,
} from '../lib/config.js';
import { defaultLogPath, readSyncLog, type SyncLogEntry } from '../lib/log.js';
import { readLockfile } from '../lib/lockfile.js';
import { bold, dim, green, red, yellow } from '../lib/term.js';
import type { Lockfile } from '../lib/types.js';

class UserError extends Error {
  readonly exitCode = 1;
}

export interface RunStatusOpts {
  configPath: string;
  lockfilePath: string;
  logPath?: string;
  /** How many recent log entries to include in the tail view. Defaults to 5. */
  recentLimit?: number;
  json?: boolean;
  quiet?: boolean;
}

export interface StatusRow {
  url: string;
  policy: SyncPolicy;
  lastSync: string | null;
  sha: string | null;
  /** Coarse state derived from the lockfile and most recent log entry. */
  status: 'up-to-date' | 'skipped' | 'error' | 'never-synced';
  /** Short, human-readable detail (skip reason / error tail / '(new)'). */
  detail?: string;
}

export interface StatusReport {
  sources: StatusRow[];
  recent: SyncLogEntry[];
}

function resolvePolicy(source: ConfigSource, config: CcppConfig): SyncPolicy {
  return source.policy ?? config.syncPolicy ?? 'pinned';
}

function mostRecentFor(url: string, log: SyncLogEntry[]): SyncLogEntry | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.sourceUrl === url) return log[i];
  }
  return undefined;
}

function classify(
  source: ConfigSource,
  lock: Lockfile,
  log: SyncLogEntry[],
): Pick<StatusRow, 'status' | 'detail'> {
  const locked = lock.sources[source.url];
  const last = mostRecentFor(source.url, log);
  if (!locked) {
    return { status: 'never-synced', detail: '(no sync recorded)' };
  }
  if (!last) return { status: 'up-to-date' };
  if (last.outcome === 'error') {
    return { status: 'error', detail: last.error?.slice(0, 80) ?? 'unknown error' };
  }
  if (last.outcome === 'skipped') {
    return { status: 'skipped', detail: 'autoAccept=false or user-declined' };
  }
  return { status: 'up-to-date' };
}

export async function runStatus(opts: RunStatusOpts): Promise<StatusReport> {
  const config = await readConfig(opts.configPath).catch((err: Error) => {
    throw new UserError(err.message);
  });
  if (!config) {
    throw new UserError(
      `No ${CONFIG_FILENAME} at ${opts.configPath}. Run \`ccpp init\` first or pass --config <path>.`,
    );
  }
  const lockfile = await readLockfile(opts.lockfilePath).catch((err: Error) => {
    throw new UserError(err.message);
  });
  const log = await readSyncLog(undefined, opts.logPath ?? defaultLogPath());

  const rows: StatusRow[] = config.sources.map((source) => {
    const locked = lockfile.sources[source.url];
    const { status, detail } = classify(source, lockfile, log);
    const row: StatusRow = {
      url: source.url,
      policy: resolvePolicy(source, config),
      lastSync: locked?.lastSync ?? null,
      sha: locked?.sha ?? null,
      status,
    };
    if (detail !== undefined) row.detail = detail;
    return row;
  });

  const recentLimit = opts.recentLimit ?? 5;
  const recent = log.slice(-recentLimit);

  const report: StatusReport = { sources: rows, recent };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report;
  }
  if (!opts.quiet) emitHuman(report);
  return report;
}

function emitHuman(report: StatusReport): void {
  if (report.sources.length === 0) {
    process.stdout.write(`${dim('(no sources configured)')}\n`);
  } else {
    const header = [bold('SOURCE'), bold('POLICY'), bold('LAST_SYNC'), bold('SHA'), bold('STATUS')];
    const rows: string[][] = [header];
    for (const s of report.sources) {
      rows.push([
        s.url,
        s.policy,
        s.lastSync ?? dim('—'),
        s.sha ? s.sha.slice(0, 7) : dim('—'),
        renderStatus(s),
      ]);
    }
    const widths = rows[0]!.map((_c, i) =>
      Math.max(...rows.map((r) => stripColor(r[i] ?? '').length)),
    );
    for (const row of rows) {
      const line = row
        .map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i]! - stripColor(cell).length)))
        .join('  ');
      process.stdout.write(`${line}\n`);
    }
  }

  if (report.recent.length > 0) {
    process.stdout.write(`\n${bold('Recent events:')}\n`);
    for (const e of report.recent) {
      const icon =
        e.outcome === 'success' ? green('✓') : e.outcome === 'skipped' ? yellow('!') : red('✗');
      const summary = e.changeset
        ? `+${e.changeset.added}/~${e.changeset.modified}/-${e.changeset.removed}`
        : e.error
          ? e.error.slice(0, 60)
          : '';
      const source = e.sourceUrl ? ` ${dim(e.sourceUrl)}` : '';
      process.stdout.write(`  ${icon} ${e.timestamp}  ${e.trigger}${source}  ${summary}\n`.trimEnd() + '\n');
    }
  }
}

function renderStatus(row: StatusRow): string {
  const base =
    row.status === 'up-to-date'
      ? green('up-to-date')
      : row.status === 'skipped'
        ? yellow('skipped')
        : row.status === 'error'
          ? red('error')
          : dim('never-synced');
  return row.detail ? `${base} ${dim(`(${row.detail})`)}` : base;
}

function stripColor(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
