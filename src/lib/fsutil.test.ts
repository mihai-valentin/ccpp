import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSafe } from './fsutil.js';

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
});
