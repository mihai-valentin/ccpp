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
