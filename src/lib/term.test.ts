import { describe, expect, it } from 'vitest';
import { formatTable, stripColor } from './term.js';

describe('stripColor', () => {
  it('removes SGR escape sequences', () => {
    const colored = '\x1b[32mok\x1b[39m';
    expect(stripColor(colored)).toBe('ok');
  });

  it('leaves plain strings alone', () => {
    expect(stripColor('plain')).toBe('plain');
  });

  it('handles strings with multiple SGR runs', () => {
    expect(stripColor('\x1b[1mA\x1b[22m \x1b[31mB\x1b[39m')).toBe('A B');
  });

  it('handles empty input', () => {
    expect(stripColor('')).toBe('');
  });
});

describe('formatTable', () => {
  it('column-aligns by visible width, ignoring SGR codes', () => {
    const out = formatTable([
      ['NAME', 'AGE'],
      ['\x1b[32malice\x1b[39m', '30'],
      ['bob', '5'],
    ]);
    // Column widths derived from `alice` (5) and `30` (2) — header gets padded to match.
    expect(out).toEqual(['NAME   AGE', '\x1b[32malice\x1b[39m  30 ', 'bob    5  ']);
  });

  it('returns an empty array for an empty input', () => {
    expect(formatTable([])).toEqual([]);
  });

  it('handles a single-row table', () => {
    expect(formatTable([['only']])).toEqual(['only']);
  });

  it('pads short cells to match the widest value in their column', () => {
    const out = formatTable([
      ['a', 'longer'],
      ['bb', 'b'],
    ]);
    // Column 0 = max(1,2)=2; column 1 = max(6,1)=6.
    expect(out).toEqual(['a   longer', 'bb  b     ']);
  });
});
