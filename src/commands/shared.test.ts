import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectTransientClaudeHomeMismatch } from './shared.js';

describe('detectTransientClaudeHomeMismatch', () => {
  it('warns when claudeHome is in tmpdir but lockfile is persistent', () => {
    const claudeHome = join(tmpdir(), 'ccpp-int-fake', 'claude');
    const lockfilePath = '/home/mihai/.ccpp/ccpp.lock.json';
    const msg = detectTransientClaudeHomeMismatch(claudeHome, lockfilePath);
    expect(msg).not.toBeNull();
    expect(msg).toContain(claudeHome);
    expect(msg).toContain(lockfilePath);
  });

  it('returns null when both are under tmpdir', () => {
    const claudeHome = join(tmpdir(), 'ccpp-int-fake', 'claude');
    const lockfilePath = join(tmpdir(), 'ccpp-int-fake', 'project', 'ccpp.lock.json');
    expect(detectTransientClaudeHomeMismatch(claudeHome, lockfilePath)).toBeNull();
  });

  it('returns null when both are persistent (default case)', () => {
    expect(
      detectTransientClaudeHomeMismatch('/home/mihai/.claude', '/home/mihai/.ccpp/ccpp.lock.json'),
    ).toBeNull();
  });

  it('returns null when claudeHome equals tmpdir but lockfile is also under it', () => {
    expect(
      detectTransientClaudeHomeMismatch(tmpdir(), join(tmpdir(), 'foo', 'lock.json')),
    ).toBeNull();
  });

  it('does not false-positive on a path that merely starts with tmpdir-like text', () => {
    // tmpdir() typically starts with '/tmp'. A claude-home at '/tmpfile/claude'
    // is NOT under tmpdir — the path-separator boundary check guards this.
    const tmp = tmpdir();
    if (tmp === '/tmp') {
      // Only meaningful when tmpdir is literally '/tmp'.
      expect(
        detectTransientClaudeHomeMismatch('/tmpfile/claude', '/home/mihai/.ccpp/ccpp.lock.json'),
      ).toBeNull();
    }
  });
});
