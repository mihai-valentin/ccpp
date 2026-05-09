/**
 * Deterministic JSON serialization — keys sorted alphabetically, 2-space
 * indent, no trailing newline (callers append one if they want it on disk).
 *
 * Used by `lockfile.ts` and `config.ts` so two ccpp runs over the same logical
 * state produce byte-identical files. That makes diffs against version control
 * meaningful and makes "did anything actually change?" cheap to answer.
 */
export function stableStringifyValue(value: unknown, indent = 0): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const nextIndent = indent + 2;
    const pad = ' '.repeat(nextIndent);
    const end = ' '.repeat(indent);
    const items = value.map((v) => `${pad}${stableStringifyValue(v, nextIndent)}`);
    return `[\n${items.join(',\n')}\n${end}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (keys.length === 0) return '{}';
    const nextIndent = indent + 2;
    const pad = ' '.repeat(nextIndent);
    const end = ' '.repeat(indent);
    const entries = keys.map((k) => {
      const v = (value as Record<string, unknown>)[k];
      return `${pad}${JSON.stringify(k)}: ${stableStringifyValue(v, nextIndent)}`;
    });
    return `{\n${entries.join(',\n')}\n${end}}`;
  }
  // undefined / function / symbol — represent as null. Shouldn't happen for
  // domain values; callers should not pass these.
  return 'null';
}
