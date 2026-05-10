import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './fsutil.js';
import { isIsoTimestamp } from './iso.js';
import { stableStringifyValue } from './json-stable.js';
import type { LockInstalledEntry, LockSourceEntry, Lockfile } from './types.js';

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

  const rawSources = obj.sources;
  if (!rawSources || typeof rawSources !== 'object' || Array.isArray(rawSources)) {
    throw new Error(`Invalid lockfile ${path}: "sources" must be an object.`);
  }
  const sources: Record<string, LockSourceEntry> = {};
  for (const [url, entry] of Object.entries(rawSources as Record<string, unknown>)) {
    sources[url] = validateSourceEntry(entry, url, path);
  }

  const rawInstalled = obj.installed;
  if (!rawInstalled || typeof rawInstalled !== 'object' || Array.isArray(rawInstalled)) {
    throw new Error(`Invalid lockfile ${path}: "installed" must be an object.`);
  }
  const installed: Record<string, LockInstalledEntry> = {};
  for (const [destPath, entry] of Object.entries(rawInstalled as Record<string, unknown>)) {
    installed[destPath] = validateInstalledEntry(entry, destPath, path);
  }

  return { version: 1, sources, installed };
}

function validateSourceEntry(entry: unknown, url: string, path: string): LockSourceEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Invalid lockfile ${path}: sources["${url}"] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  requireString(e.sha, `sources["${url}"].sha`, path);
  requireString(e.ref, `sources["${url}"].ref`, path);
  requireIsoTimestamp(e.lastSync, `sources["${url}"].lastSync`, path);
  return {
    sha: e.sha as string,
    ref: e.ref as string,
    lastSync: e.lastSync as string,
  };
}

function validateInstalledEntry(
  entry: unknown,
  destPath: string,
  path: string,
): LockInstalledEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Invalid lockfile ${path}: installed["${destPath}"] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  requireString(e.sourceUrl, `installed["${destPath}"].sourceUrl`, path);
  requireString(e.sourcePath, `installed["${destPath}"].sourcePath`, path);
  requireString(e.sourceSha, `installed["${destPath}"].sourceSha`, path);
  requireIsoTimestamp(e.installedAt, `installed["${destPath}"].installedAt`, path);
  return {
    sourceUrl: e.sourceUrl as string,
    sourcePath: e.sourcePath as string,
    sourceSha: e.sourceSha as string,
    installedAt: e.installedAt as string,
  };
}

function requireString(v: unknown, field: string, path: string): void {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Invalid lockfile ${path}: ${field} must be a non-empty string.`);
  }
}

function requireIsoTimestamp(v: unknown, field: string, path: string): void {
  if (typeof v !== 'string' || !isIsoTimestamp(v)) {
    throw new Error(`Invalid lockfile ${path}: ${field} must be an ISO-8601 timestamp.`);
  }
}

