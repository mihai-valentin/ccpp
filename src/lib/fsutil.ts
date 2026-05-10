import { randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';

/** Default file-size cap for {@link readFileSafe}. 50 MB — generous for any
 * Claude Code skill/command/agent file shape, defensive against an adversarial
 * source committing a multi-GB blob that would otherwise be slurped into RAM. */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface ReadFileSafeOpts {
  /** Maximum size in bytes. Defaults to {@link DEFAULT_MAX_FILE_BYTES}. */
  maxBytes?: number;
}

/**
 * Read file bytes, refusing to follow symlinks and refusing files above
 * {@link ReadFileSafeOpts.maxBytes} (default 50 MB).
 *
 * Source repositories are partially-trusted input: a malicious source could
 * commit a symlink pointing at something outside the clone (e.g. `~/.ssh/id_rsa`
 * or `/etc/passwd`) and, if ccpp followed it, end up copying its contents into
 * `~/.claude/` — where Claude Code reads files during every session.
 *
 * Implementation: opens the path with `O_NOFOLLOW`, which makes the kernel
 * fail the open with `ELOOP` if the final path component is a symlink. This
 * resolves the path, checks the type, and reads the bytes in a single
 * atomic operation — there is no lstat-then-read window an attacker could
 * race. Falls back to the lstat-style error for the symlink-rejection case
 * so the message is consistent with what users see today.
 *
 * Throws with the offending path named so users can diagnose adversarial sources.
 */
export async function readFileSafe(path: string, opts: ReadFileSafeOpts = {}): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  let fd: fs.FileHandle;
  try {
    fd = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(
        `Refusing to read symlink: ${path}. ccpp does not follow symlinks from source repos — this would allow a source to leak files from elsewhere on the filesystem into ~/.claude/.`,
      );
    }
    throw err;
  }
  try {
    // Size check on the open fd (not a fresh stat) — same inode the read
    // will operate on, so the size cannot drift between check and read.
    const stat = await fd.stat();
    if (stat.size > maxBytes) {
      throw new Error(
        `Refusing to read ${path}: file size ${stat.size} bytes exceeds ${maxBytes} byte limit. Pass a larger maxBytes to readFileSafe if this file is legitimately large.`,
      );
    }
    return await fd.readFile();
  } finally {
    await fd.close().catch(() => {});
  }
}

/**
 * Atomically write a UTF-8 string (typically JSON) to `path` via temp + rename.
 *
 * Plain `fs.writeFile` is non-atomic — a SIGINT or crash between truncation and
 * the final flush leaves a half-written file on disk. ccpp's lockfile, config,
 * and `~/.claude/settings.json` writes all use this helper because each is read
 * by another long-lived process (Claude Code) or the next ccpp run, so a torn
 * write would surface as a JSON parse error rather than a silent revert.
 *
 * The temp filename includes a random suffix to avoid collisions when two ccpp
 * runs interleave (e.g. a user re-running install while a SessionStart hook is
 * mid-sync). On success, the rename is atomic on the same filesystem; on
 * failure, the temp file is cleaned up best-effort.
 */
export async function writeFileAtomic(path: string, content: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`;
  await fs.mkdir(dirname(path), { recursive: true });
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Best-effort exists check. Does not distinguish missing from inaccessible. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
