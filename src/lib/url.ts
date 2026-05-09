/**
 * Split a `<url>@<ref>` shorthand into its parts.
 *
 * The trailing `@<ref>` is recognized only when the `@` appears after the
 * last `/` or `:` in the input — otherwise it's part of an SCP-style SSH
 * URL (`git@host:path`) or HTTPS auth (`https://user:pass@host/path`).
 *
 * Refs containing `/`, `:`, or whitespace are not allowed via shorthand;
 * users must fall back to `--ref` for those (multiple `@` are tolerated —
 * the parser splits on the *last* one). Splits also refuse `@` at index 0
 * because there's no URL before the separator.
 */
export function splitUrlRef(input: string): { url: string; ref?: string } {
  const lastAt = input.lastIndexOf('@');
  if (lastAt === -1) return { url: input };

  const lastSlash = input.lastIndexOf('/');
  const lastColon = input.lastIndexOf(':');
  const pathStart = Math.max(lastSlash, lastColon);

  if (lastAt < pathStart) return { url: input };
  if (lastAt === 0) return { url: input };

  const ref = input.slice(lastAt + 1);
  if (ref.length === 0) return { url: input };
  if (/[\s/:]/.test(ref)) return { url: input };

  return { url: input.slice(0, lastAt), ref };
}
