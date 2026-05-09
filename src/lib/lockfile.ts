import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './fsutil.js';
import { stableStringifyValue } from './json-stable.js';
import type { Lockfile } from './types.js';

/** Path of `ccpp.lock.json` relative to a working directory. */
export const LOCKFILE_FILENAME = 'ccpp.lock.json';

/** A fresh, empty lockfile ready to be populated and written. */
export function emptyLockfile(): Lockfile {
  return { version: 1, sources: {}, installed: {} };
}

/**
 * Read a lockfile from disk. Returns a fresh empty lockfile when the file
 * does not exist. Throws a descriptive error for malformed content or for
 * unknown schema versions.
 */
export async function readLockfile(path: string): Promise<Lockfile> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyLockfile();
    }
    throw new Error(`Failed to read lockfile ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse lockfile ${path}: ${(err as Error).message}`);
  }
  return validateLockfile(parsed, path);
}

/**
 * Serialise a lockfile deterministically and write it to disk. Keys are
 * sorted, indentation is two spaces, and a trailing newline is appended so
 * diffs are stable across runs. Writes are atomic (temp + rename) — see
 * `fsutil.writeFileAtomic`.
 */
export async function writeLockfile(path: string, lockfile: Lockfile): Promise<void> {
  await writeFileAtomic(path, stableStringify(lockfile));
}

/**
 * Deterministic JSON string for a lockfile: object keys sorted alphabetically,
 * 2-space indent, trailing newline.
 */
export function stableStringify(lockfile: Lockfile): string {
  return `${stableStringifyValue(lockfile)}\n`;
}

function validateLockfile(raw: unknown, path: string): Lockfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid lockfile ${path}: expected a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(
      `Unsupported lockfile version at ${path}: expected 1, got ${JSON.stringify(obj.version)}.`,
    );
  }
  const sources = obj.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new Error(`Invalid lockfile ${path}: "sources" must be an object.`);
  }
  const installed = obj.installed;
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
    throw new Error(`Invalid lockfile ${path}: "installed" must be an object.`);
  }
  return {
    version: 1,
    sources: sources as Lockfile['sources'],
    installed: installed as Lockfile['installed'],
  };
}
