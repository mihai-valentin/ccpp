import { describe, expect, it } from 'vitest';
import { splitUrlRef } from './url.js';

describe('splitUrlRef', () => {
  it('keeps an `@` at position 0 (no preceding path) intact', () => {
    // `@feature` has lastAt=0 < pathStart=-1 — but Math.max(-1,-1) = -1 so
    // the condition `lastAt < pathStart` is false. We still expect no split
    // because there's no actual URL before the @.
    expect(splitUrlRef('@feature')).toEqual({ url: '@feature' });
  });

  it('returns the input unchanged when no @ is present', () => {
    expect(splitUrlRef('https://github.com/u/r')).toEqual({ url: 'https://github.com/u/r' });
    expect(splitUrlRef('https://github.com/u/r.git')).toEqual({
      url: 'https://github.com/u/r.git',
    });
  });

  it('keeps SCP-style SSH URLs intact when no ref suffix is given', () => {
    expect(splitUrlRef('git@bitbucket.org:my/repo')).toEqual({
      url: 'git@bitbucket.org:my/repo',
    });
    expect(splitUrlRef('git@github.com:u/r.git')).toEqual({
      url: 'git@github.com:u/r.git',
    });
  });

  it('parses @<ref> off an SCP-style SSH URL', () => {
    expect(splitUrlRef('git@bitbucket.org:my/repo@abc123')).toEqual({
      url: 'git@bitbucket.org:my/repo',
      ref: 'abc123',
    });
    expect(splitUrlRef('git@github.com:u/r.git@v1.0.0')).toEqual({
      url: 'git@github.com:u/r.git',
      ref: 'v1.0.0',
    });
  });

  it('parses @<ref> off an HTTPS URL', () => {
    expect(splitUrlRef('https://github.com/u/r@v1.0')).toEqual({
      url: 'https://github.com/u/r',
      ref: 'v1.0',
    });
    expect(splitUrlRef('https://github.com/u/r.git@deadbeef')).toEqual({
      url: 'https://github.com/u/r.git',
      ref: 'deadbeef',
    });
  });

  it('does not mistake HTTPS auth for a ref suffix', () => {
    expect(splitUrlRef('https://user:pass@github.com/u/r')).toEqual({
      url: 'https://user:pass@github.com/u/r',
    });
  });

  it('parses @<ref> when both auth and ref are present', () => {
    expect(splitUrlRef('https://user:pass@github.com/u/r@v1.0')).toEqual({
      url: 'https://user:pass@github.com/u/r',
      ref: 'v1.0',
    });
  });

  it('refuses refs that contain slashes (ambiguous with paths)', () => {
    // The user must fall back to --ref for `feature/foo`.
    expect(splitUrlRef('https://github.com/u/r@feature/foo')).toEqual({
      url: 'https://github.com/u/r@feature/foo',
    });
  });

  it('refuses an empty trailing ref', () => {
    expect(splitUrlRef('https://github.com/u/r@')).toEqual({
      url: 'https://github.com/u/r@',
    });
  });

  it('splits on the last @ when multiple are present in the path tail', () => {
    expect(splitUrlRef('https://github.com/u/r@bad@ref')).toEqual({
      url: 'https://github.com/u/r@bad',
      ref: 'ref',
    });
  });

  it('refuses refs containing whitespace', () => {
    expect(splitUrlRef('https://github.com/u/r@bad ref')).toEqual({
      url: 'https://github.com/u/r@bad ref',
    });
  });
});
