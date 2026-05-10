/**
 * True when `s` is a parseable ISO-8601 timestamp.
 *
 * Date.parse returns NaN for unparseable input. The round-trip check
 * (compare the year-month-day prefix that Date back-formats with the input
 * prefix) rejects loose strings like `"today"`, `"2026"`, or `"04/22/2026"`
 * that Date.parse may otherwise tolerate on some Node versions.
 */
export function isIsoTimestamp(s: string): boolean {
  const parsed = Date.parse(s);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === s.slice(0, 10);
}
