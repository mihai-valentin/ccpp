import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathExists, readFileSafe, writeFileAtomic } from './fsutil.js';

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-fsutil-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('readFileSafe', () => {
  it('reads regular files without touching them', async () => {
    const path = join(scratch, 'regular.txt');
    await fs.writeFile(path, 'hello');
    const bytes = await readFileSafe(path);
    expect(bytes.toString('utf8')).toBe('hello');
  });

  it('refuses to follow a symlink, naming the offending path in the error', async () => {
    const real = join(scratch, 'real.txt');
    await fs.writeFile(real, 'target bytes');
    const link = join(scratch, 'link.txt');
    await fs.symlink(real, link);

    await expect(readFileSafe(link)).rejects.toThrow(/refusing to read symlink/i);
    await expect(readFileSafe(link)).rejects.toThrow(link);
  });

  it('refuses a dangling symlink too (never attempts to resolve)', async () => {
    const link = join(scratch, 'dangling.txt');
    await fs.symlink(join(scratch, 'does-not-exist'), link);
    await expect(readFileSafe(link)).rejects.toThrow(/refusing to read symlink/i);
  });

  it('refuses a symlink pointing outside the containing directory', async () => {
    const outsideTarget = join(scratch, '..', '..', 'etc', 'passwd');
    const link = join(scratch, 'leak');
    await fs.symlink(outsideTarget, link);
    await expect(readFileSafe(link)).rejects.toThrow(/refusing to read symlink/i);
  });

  it('propagates ENOENT for a missing regular file (unchanged from fs.readFile)', async () => {
    await expect(readFileSafe(join(scratch, 'nope.txt'))).rejects.toThrow(/ENOENT|no such file/i);
  });

  it('refuses files larger than maxBytes', async () => {
    const path = join(scratch, 'big.bin');
    await fs.writeFile(path, Buffer.alloc(1024)); // 1 KiB
    await expect(readFileSafe(path, { maxBytes: 256 })).rejects.toThrow(/exceeds 256 byte limit/);
  });

  it('reads files up to and including maxBytes', async () => {
    const path = join(scratch, 'exact.bin');
    await fs.writeFile(path, Buffer.alloc(256));
    const bytes = await readFileSafe(path, { maxBytes: 256 });
    expect(bytes.length).toBe(256);
  });
});

describe('writeFileAtomic', () => {
  it('creates intermediate directories and writes the final file in place', async () => {
    const target = join(scratch, 'nested', 'dir', 'output.json');
    await writeFileAtomic(target, '{"hello":1}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"hello":1}');
    // The temp file is gone after the rename.
    const siblings = await fs.readdir(join(scratch, 'nested', 'dir'));
    expect(siblings).toEqual(['output.json']);
  });

  it('overwrites an existing target', async () => {
    const target = join(scratch, 'a.json');
    await fs.writeFile(target, 'old');
    await writeFileAtomic(target, 'new');
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });

  it('does not leave a tmp file behind on success', async () => {
    const target = join(scratch, 'b.json');
    await writeFileAtomic(target, 'x');
    const siblings = await fs.readdir(scratch);
    // Only the target file should remain — no `.tmp.*` leftovers.
    expect(siblings.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });
});

describe('pathExists', () => {
  it('returns true for an existing file', async () => {
    const p = join(scratch, 'x');
    await fs.writeFile(p, '');
    expect(await pathExists(p)).toBe(true);
  });

  it('returns false for a missing path', async () => {
    expect(await pathExists(join(scratch, 'nope'))).toBe(false);
  });
});
