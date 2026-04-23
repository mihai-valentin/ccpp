import { createInterface } from 'node:readline';

const CSI = '\x1b[';

function colorEnabled(): boolean {
  if (process.env['NO_COLOR']) return false;
  if (process.env['CCPP_NO_COLOR']) return false;
  return Boolean(process.stdout.isTTY);
}

function wrap(open: string, close: string): (s: string) => string {
  return (s: string) => (colorEnabled() ? `${CSI}${open}m${s}${CSI}${close}m` : s);
}

export const green = wrap('32', '39');
export const yellow = wrap('33', '39');
export const red = wrap('31', '39');
export const dim = wrap('2', '22');
export const bold = wrap('1', '22');

export function disableColor(): void {
  process.env['CCPP_NO_COLOR'] = '1';
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
