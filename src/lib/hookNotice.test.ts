import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noticeFilePath, pickAgentPaths, writeHookNotice } from './hookNotice.js';

let scratch: string;
let logPath: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-notice-'));
  logPath = join(scratch, 'sync.log');
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('noticeFilePath', () => {
  it('co-locates the notice file next to the sync log', () => {
    expect(noticeFilePath('/var/lib/ccpp/sync.log')).toBe('/var/lib/ccpp/last-hook-notice.txt');
  });
});

describe('pickAgentPaths', () => {
  const home = '/home/u/.claude';

  it('returns only paths under <claudeHome>/agents/', () => {
    const dests = [
      `${home}/agents/skeptic.md`,
      `${home}/commands/git-commit.md`,
      `${home}/skills/pr-summary/SKILL.md`,
      `${home}/agents/triage.md`,
    ];
    expect(pickAgentPaths(dests, home)).toEqual([
      `${home}/agents/skeptic.md`,
      `${home}/agents/triage.md`,
    ]);
  });

  it('returns [] when no agents changed', () => {
    expect(pickAgentPaths([`${home}/commands/foo.md`], home)).toEqual([]);
  });

  it('does not match a sibling dir whose name starts with "agents"', () => {
    // Guards against a naive `includes("/agents")` regression — `/agents-archive/`
    // must NOT be treated as the agents dir.
    expect(pickAgentPaths([`${home}/agents-archive/old.md`], home)).toEqual([]);
  });

  it('returns [] for an empty input list', () => {
    expect(pickAgentPaths([], home)).toEqual([]);
  });
});

describe('writeHookNotice', () => {
  it('writes the message to the notice file with a trailing newline', async () => {
    await writeHookNotice(logPath, '[ccpp] 1 agent changed');
    const body = await fs.readFile(noticeFilePath(logPath), 'utf8');
    expect(body).toBe('[ccpp] 1 agent changed\n');
  });

  it('creates the parent dir if missing', async () => {
    const nested = join(scratch, 'deep', 'nested', 'sync.log');
    await writeHookNotice(nested, 'hello');
    const body = await fs.readFile(noticeFilePath(nested), 'utf8');
    expect(body).toBe('hello\n');
  });

  it('overwrites any pre-existing notice (one-shot semantics)', async () => {
    await writeHookNotice(logPath, 'first');
    await writeHookNotice(logPath, 'second');
    const body = await fs.readFile(noticeFilePath(logPath), 'utf8');
    expect(body).toBe('second\n');
  });

  it('does not throw when the target dir is unwritable', async () => {
    // Best-effort: notice writes must never break sync. Point at a path
    // that's inside a regular file (so mkdir will fail) and assert silence.
    const blockerFile = join(scratch, 'blocker');
    await fs.writeFile(blockerFile, '');
    const bogus = join(blockerFile, 'sync.log');
    await expect(writeHookNotice(bogus, 'irrelevant')).resolves.toBeUndefined();
  });
});
