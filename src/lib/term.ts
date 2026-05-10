import { createInterface } from 'node:readline';

/** ANSI Control Sequence Introducer — the `ESC [` prefix every SGR escape starts with. */
const CSI = '\x1b[';

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.CCPP_NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

/**
 * Wrap a string in an SGR (Select Graphic Rendition) pair. The returned
 * function re-evaluates `colorEnabled()` on every call (rather than at
 * module-load time) so `disableColor()` and tests that mutate
 * `process.env.CCPP_NO_COLOR` after import take effect immediately.
 */
function wrap(open: string, close: string): (s: string) => string {
  return (s: string) => (colorEnabled() ? `${CSI}${open}m${s}${CSI}${close}m` : s);
}

// SGR codes — `<open>m...<close>m`. 30-37 = foreground colors; 39 = default
// foreground. 1 = bold, 2 = dim, 22 = normal-intensity (closes both).
export const green = wrap('32', '39');
export const yellow = wrap('33', '39');
export const red = wrap('31', '39');
export const dim = wrap('2', '22');
export const bold = wrap('1', '22');

export function disableColor(): void {
  process.env.CCPP_NO_COLOR = '1';
}

/**
 * Standard short-SHA length used in git tooling and ccpp's user-facing output.
 * Centralized so every place that abbreviates a commit SHA shows the same
 * number of characters.
 */
export const SHORT_SHA_LEN = 7;

/** Truncate a commit SHA to the conventional short form for display. */
export function formatShortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LEN);
}

/** Strip ANSI escape sequences (SGR colors only — not full ECMA-48). */
export function stripColor(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escape stripping — \x1b is load-bearing.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * True when both stdin and stderr are TTYs — used to decide whether
 * interactive prompts can be surfaced. Centralized so every subcommand
 * applies the same rule.
 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY);
}

/**
 * Render a 2-D string array as a column-aligned table, two-space gutter
 * between columns. Cells may contain ANSI color codes — `stripColor` is used
 * for width computation so widths stay correct under color.
 */
export function formatTable(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const ncols = rows[0]!.length;
  const widths: number[] = [];
  for (let i = 0; i < ncols; i++) {
    widths.push(Math.max(...rows.map((r) => stripColor(r[i] ?? '').length)));
  }
  return rows.map((row) =>
    row
      .map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i]! - stripColor(cell).length)))
      .join('  '),
  );
}

/**
 * Write `message` to stderr, read one line from stdin, and resolve true
 * iff the reply was y/yes (case-insensitive, trimmed). Any other input —
 * including empty / EOF — resolves false, matching the `[y/N]` convention.
 */
export function promptYesNo(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stderr.write(`${message} `);
    const rl = createInterface({ input: process.stdin, terminal: false });
    let resolved = false;
    const finish = (answer: boolean): void => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(answer);
    };
    rl.once('line', (line: string) => {
      const a = line.trim().toLowerCase();
      finish(a === 'y' || a === 'yes');
    });
    rl.once('close', () => finish(false));
  });
}

/**
 * Write `message` to stderr, read one line from stdin, and resolve the
 * trimmed input. If the user hits enter with no input and a `defaultValue`
 * was supplied, that default is returned. On EOF with no default, resolves
 * to an empty string — callers validate/retry.
 */
export function promptLine(message: string, opts: { defaultValue?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const suffix = opts.defaultValue !== undefined ? ` [${opts.defaultValue}]` : '';
    process.stderr.write(`${message}${suffix} `);
    const rl = createInterface({ input: process.stdin, terminal: false });
    let resolved = false;
    const finish = (answer: string): void => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(answer);
    };
    rl.once('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 && opts.defaultValue !== undefined) {
        finish(opts.defaultValue);
      } else {
        finish(trimmed);
      }
    });
    rl.once('close', () => finish(opts.defaultValue ?? ''));
  });
}

/**
 * Default cap on retries for {@link promptChoice}. Three is enough to
 * recover from a typo without livelocking on a non-interactive stdin
 * that's stuck on EOF.
 */
const MAX_PROMPT_ATTEMPTS = 3;

/**
 * Prompt the user to pick one of `choices`. Accepts either the numeric index
 * (1-based, as shown) or the literal choice string. Empty input selects
 * `defaultValue`. Invalid input retries up to `maxAttempts` times; on
 * exhaustion, resolves to `defaultValue`.
 */
export async function promptChoice<T extends string>(
  message: string,
  choices: readonly T[],
  defaultValue: T,
  maxAttempts = MAX_PROMPT_ATTEMPTS,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const list = choices
      .map((c, i) => `${i + 1}) ${c}${c === defaultValue ? ' (default)' : ''}`)
      .join('  ');
    const answer = await promptLine(`${message}\n  ${list}\n>`, { defaultValue });
    const lower = answer.trim().toLowerCase();
    if (lower === '') return defaultValue;
    const asIndex = Number.parseInt(lower, 10);
    if (!Number.isNaN(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
      return choices[asIndex - 1] as T;
    }
    const byLabel = choices.find((c) => c.toLowerCase() === lower);
    if (byLabel !== undefined) return byLabel;
    process.stderr.write(
      `  not recognised — enter 1-${choices.length} or one of: ${choices.join(', ')}\n`,
    );
  }
  return defaultValue;
}
