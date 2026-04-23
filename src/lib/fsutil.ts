import { promises as fs } from 'node:fs';

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
      `Refusing to read symlink: ${path}. ccpp does not follow symlinks from source repos — ` +
        'this would allow a source to leak files from elsewhere on the filesystem into ~/.claude/.',
    );
  }
  return fs.readFile(path);
}
