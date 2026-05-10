import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LocalGitFixture,
  createLocalGitFixture,
} from '../../tests/helpers/local-git-fixture.js';
import { cachePathFor, clearCache, cloneOrUpdate, parseRepoUrl, runGit } from './git.js';

describe('parseRepoUrl', () => {
  it('parses an SSH scp-form URL (git@host:owner/repo.git)', () => {
    expect(parseRepoUrl('git@bitbucket.org:example-org/ai-plugins.git')).toEqual({
      host: 'bitbucket.org',
      owner: 'example-org',
      repo: 'ai-plugins',
    });
  });

  it('parses an https URL without .git suffix', () => {
    expect(parseRepoUrl('https://github.com/foo/bar')).toEqual({
      host: 'github.com',
      owner: 'foo',
      repo: 'bar',
    });
  });

  it('parses an https URL with .git suffix', () => {
    expect(parseRepoUrl('https://github.com/foo/bar.git')).toEqual({
      host: 'github.com',
      owner: 'foo',
      repo: 'bar',
    });
  });

  it('parses an ssh://-scheme URL', () => {
    expect(parseRepoUrl('ssh://git@gitlab.com/foo/bar.git')).toEqual({
      host: 'gitlab.com',
      owner: 'foo',
      repo: 'bar',
    });
  });

  it('parses a self-hosted URL with nested group path', () => {
    expect(parseRepoUrl('https://self-hosted.example.com/group/sub/repo.git')).toEqual({
      host: 'self-hosted.example.com',
      owner: 'group/sub',
      repo: 'repo',
    });
  });

  it('rejects empty URLs', () => {
    expect(() => parseRepoUrl('')).toThrow(/empty/);
  });

  it('rejects URLs that lack an owner/repo path', () => {
    expect(() => parseRepoUrl('https://github.com/')).toThrow(/owner\/repo/);
  });
});

describe('cachePathFor', () => {
  it('lays out the cache under <root>/<host>/<owner>/<repo>', () => {
    expect(cachePathFor('git@bitbucket.org:example-org/ai-plugins.git', '/cache')).toBe(
      join('/cache', 'bitbucket.org', 'example-org', 'ai-plugins'),
    );
  });

  it('preserves nested-group paths in the cache layout', () => {
    expect(cachePathFor('https://self-hosted.example.com/group/sub/repo.git', '/cache')).toBe(
      join('/cache', 'self-hosted.example.com', 'group', 'sub', 'repo'),
    );
  });
});

describe('cloneOrUpdate', () => {
  let fixture: LocalGitFixture;
  let cacheRoot: string;

  beforeAll(async () => {
    fixture = await createLocalGitFixture();
    cacheRoot = await fs.mkdtemp(join(tmpdir(), 'ccpp-cache-'));
  });

  afterAll(async () => {
    await fixture.cleanup();
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  it('clones a fresh URL into the computed cache path and returns the HEAD SHA', async () => {
    const result = await cloneOrUpdate(fixture.url, { cacheRoot });

    const expectedPath = cachePathFor(fixture.url, cacheRoot);
    expect(result.localPath).toBe(expectedPath);
    expect(result.ref).toBe('main');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    await expect(fs.access(join(expectedPath, '.git'))).resolves.toBeUndefined();
    await expect(fs.access(join(expectedPath, 'README.md'))).resolves.toBeUndefined();
  });

  it('advances an existing cache to a new upstream HEAD on the next call', async () => {
    const before = await cloneOrUpdate(fixture.url, { cacheRoot });
    const newSha = await fixture.advance('new-file.txt', 'hello');

    const after = await cloneOrUpdate(fixture.url, { cacheRoot });

    expect(before.localPath).toBe(after.localPath);
    expect(after.sha).toBe(newSha);
    expect(after.sha).not.toBe(before.sha);
    await expect(fs.access(join(after.localPath, 'new-file.txt'))).resolves.toBeUndefined();
  });

  it('treats a hex-named branch as a branch (not a SHA) — ls-remote probe replaces the heuristic', async () => {
    // Set up a fresh fixture with a branch literally named like a 7-char SHA.
    const fx = await createLocalGitFixture('ccpp-hexbranch');
    const localCache = await fs.mkdtemp(join(tmpdir(), 'ccpp-hexbranch-cache-'));
    try {
      // Create branch `abc1234` on the work repo and push it.
      const tipSha = await fx.advance('on-branch.md', 'on hex branch');
      await runGit(['branch', 'abc1234'], { cwd: fx.workPath });
      await runGit(['push', 'origin', 'abc1234'], { cwd: fx.workPath });

      const result = await cloneOrUpdate(fx.url, { ref: 'abc1234', cacheRoot: localCache });
      // Sanity: we got the branch tip, not some other SHA.
      expect(result.sha).toBe(tipSha);
      expect(result.ref).toBe('abc1234');

      // The clone is on a *branch* named abc1234, not detached HEAD. After
      // checkout, `git symbolic-ref HEAD` should resolve to refs/heads/abc1234
      // — that's what proves the named-ref path was taken (the SHA path
      // would have left HEAD detached).
      const head = await runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: result.localPath });
      expect(head.stdout.trim()).toBe('refs/heads/abc1234');
    } finally {
      await fx.cleanup();
      await fs.rm(localCache, { recursive: true, force: true });
    }
  }, 30_000);

  it('still treats a real commit SHA as a SHA (full clone, detached HEAD)', async () => {
    const fx = await createLocalGitFixture('ccpp-realsha');
    const localCache = await fs.mkdtemp(join(tmpdir(), 'ccpp-realsha-cache-'));
    try {
      const sha1 = await fx.advance('one.md', 'one');
      // Advance further so the SHA we pin is not the current HEAD.
      await fx.advance('two.md', 'two');

      const result = await cloneOrUpdate(fx.url, { ref: sha1, cacheRoot: localCache });
      expect(result.sha).toBe(sha1);
      // SHA path leaves HEAD detached — symbolic-ref exits non-zero.
      await expect(
        runGit(['symbolic-ref', '-q', 'HEAD'], { cwd: result.localPath }),
      ).rejects.toThrow();
    } finally {
      await fx.cleanup();
      await fs.rm(localCache, { recursive: true, force: true });
    }
  }, 30_000);

  it('surfaces git stderr in the error when the URL cannot be cloned', async () => {
    const badDir = await fs.mkdtemp(join(tmpdir(), 'ccpp-bad-'));
    const badUrl = `file://${join(badDir, 'does-not-exist.git')}`;
    const badCache = await fs.mkdtemp(join(tmpdir(), 'ccpp-cache-bad-'));

    await expect(cloneOrUpdate(badUrl, { cacheRoot: badCache })).rejects.toThrow(
      /(does not exist|not a git repository|Could not read from remote|repository|not found)/i,
    );

    await fs.rm(badDir, { recursive: true, force: true });
    await fs.rm(badCache, { recursive: true, force: true });
  });
});

describe('clearCache', () => {
  it('removes the cache dir for a specific URL', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ccpp-clear-'));
    const dir = cachePathFor('https://github.com/foo/bar.git', root);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'marker'), 'x');

    await clearCache('https://github.com/foo/bar.git', root);

    await expect(fs.access(dir)).rejects.toThrow();
    // Parent <root>/<host>/<owner> may or may not remain — only target must be gone.

    await fs.rm(root, { recursive: true, force: true });
  });

  it('removes the entire cache when no URL is supplied', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ccpp-clear-all-'));
    await fs.writeFile(join(root, 'marker'), 'x');

    await clearCache(undefined, root);

    await expect(fs.access(root)).rejects.toThrow();
  });
});

describe('runGit environment', () => {
  it('sets GIT_TERMINAL_PROMPT=0 in the spawned env', async () => {
    const shimDir = await fs.mkdtemp(join(tmpdir(), 'ccpp-git-shim-'));
    const shim = join(shimDir, 'git');
    await fs.writeFile(shim, '#!/bin/sh\nprintf "%s" "$GIT_TERMINAL_PROMPT"\n');
    await fs.chmod(shim, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
    try {
      const { stdout } = await runGit(['noop'], { cwd: undefined });
      expect(stdout).toBe('0');
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(shimDir, { recursive: true, force: true });
    }
  });
});
