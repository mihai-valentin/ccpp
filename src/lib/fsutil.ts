import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read file bytes, refusing to follow symlinks.
 *
 * Source repositories are partially-trusted input: a malicious source could
 * commit a symlink pointing at something outside the clone (e.g. `~/.ssh/id_rsa`
 * or `/etc/passwd`) and, if ccpp followed it, end up copying its contents into
 * `~/.claude/` — where Claude Code reads files during every session. The
 * manifest walker already skips symlinks at `readdir` time via `Dirent.isFile()`,
 * but this helper is the belt-and-suspenders check at the last possible moment:
 * right before the bytes are read. It also closes the narrow TOCTOU window in
 * which a regular file at walk time could turn into a symlink before the read.
 *
 * Throws with the offending path named so users can diagnose adversarial sources.
 */
export async function readFileSafe(path: string): Promise<Buffer> {
  const stat = await fs.lstat(path);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to read symlink: ${path}. ccpp does not follow symlinks from source repos — this would allow a source to leak files from elsewhere on the filesystem into ~/.claude/.`,
    );
  }
  return fs.readFile(path);
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
