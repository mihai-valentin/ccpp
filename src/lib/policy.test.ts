import { describe, expect, it } from 'vitest';
import type { CcppConfig, ConfigSource } from './config.js';
import { effectiveAutoAccept, effectivePolicy } from './policy.js';

const baseConfig: CcppConfig = { version: 1, sources: [], scope: 'user' };

function source(overrides: Partial<ConfigSource> = {}): ConfigSource {
  return { url: 'https://example.com/x.git', ...overrides };
}

describe('effectivePolicy', () => {
  it('CLI override wins over per-source and global', () => {
    expect(
      effectivePolicy(
        source({ policy: 'pinned' }),
        { ...baseConfig, syncPolicy: 'pinned' },
        'latest',
      ),
    ).toBe('latest');
  });

  it('per-source policy wins over global when no override', () => {
    expect(
      effectivePolicy(
        source({ policy: 'latest' }),
        { ...baseConfig, syncPolicy: 'pinned' },
        undefined,
      ),
    ).toBe('latest');
  });

  it('global policy wins over the default when no override and no per-source', () => {
    expect(effectivePolicy(source(), { ...baseConfig, syncPolicy: 'latest' }, undefined)).toBe(
      'latest',
    );
  });

  it('defaults to pinned when nothing else is set', () => {
    expect(effectivePolicy(source(), baseConfig, undefined)).toBe('pinned');
  });

  it('explicit pinned override beats a latest per-source policy', () => {
    expect(effectivePolicy(source({ policy: 'latest' }), baseConfig, 'pinned')).toBe('pinned');
  });
});

describe('effectiveAutoAccept', () => {
  it('CLI flag true wins over config false', () => {
    expect(effectiveAutoAccept(true, { ...baseConfig, autoAccept: false })).toBe(true);
  });

  it('config true is honored when no flag is passed', () => {
    expect(effectiveAutoAccept(undefined, { ...baseConfig, autoAccept: true })).toBe(true);
  });

  it('CLI flag undefined and config undefined → false (default: always prompt)', () => {
    expect(effectiveAutoAccept(undefined, baseConfig)).toBe(false);
  });

  it('CLI flag false does not negate config true (no-op for disabling)', () => {
    // The intent of `--auto-accept` is to opt IN for a run. There's no way
    // to opt out via flag — the user must edit config or pass `--config`.
    expect(effectiveAutoAccept(false, { ...baseConfig, autoAccept: true })).toBe(true);
  });
});
