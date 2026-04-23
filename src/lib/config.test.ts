import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CcppConfig,
  CONFIG_FILENAME,
  emptyConfig,
  getConfigValue,
  listConfig,
  readConfig,
  resetConfigValue,
  setConfigValue,
  writeConfig,
} from './config.js';

let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-config-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('v0.1.0 backwards compatibility', () => {
  it('reads a config without any v0.1.1 fields and returns defaults on get', async () => {
    const path = join(scratch, CONFIG_FILENAME);
    await fs.writeFile(
      path,
      JSON.stringify({
        version: 1,
        scope: 'user',
        sources: [{ url: 'git@example.com:foo/bar.git' }],
      }),
      'utf8',
    );
    const config = await readConfig(path);
    expect(config).not.toBeNull();
    const c = config as CcppConfig;
    expect(c.syncPolicy).toBeUndefined();
    expect(c.autoAccept).toBeUndefined();
    expect(c.policyAcknowledgedAt).toBeUndefined();
    expect(getConfigValue(c, 'syncPolicy')).toBe('pinned');
    expect(getConfigValue(c, 'autoAccept')).toBe(false);
    expect(getConfigValue(c, 'policyAcknowledgedAt')).toBeUndefined();
  });
});

describe('round-trip', () => {
  it('writes and reads back every v0.1.1 field, including per-source policy', async () => {
    const path = join(scratch, CONFIG_FILENAME);
    const config: CcppConfig = {
      version: 1,
      scope: 'user',
      syncPolicy: 'latest',
      autoAccept: true,
      policyAcknowledgedAt: '2026-04-23T12:00:00Z',
      autoAcceptAcknowledgedAt: '2026-04-23T12:05:00Z',
      sources: [
        { url: 'git@example.com:a/a.git' },
        { url: 'git@example.com:b/b.git', policy: 'latest' },
      ],
    };
    await writeConfig(path, config);
    const reloaded = (await readConfig(path)) as CcppConfig;
    expect(reloaded).toEqual(config);
    expect(getConfigValue(reloaded, 'syncPolicy')).toBe('latest');
    expect(getConfigValue(reloaded, 'autoAccept')).toBe(true);
    expect(getConfigValue(reloaded, 'sources.git@example.com:b/b.git.policy')).toBe('latest');
    expect(getConfigValue(reloaded, 'sources.git@example.com:a/a.git.policy')).toBeUndefined();
  });
});

describe('unknown keys', () => {
  it('get throws on an unknown key', () => {
    const config = emptyConfig();
    expect(() => getConfigValue(config, 'bogus')).toThrow(/unknown config key/i);
  });

  it('set throws on an unknown key', () => {
    const config = emptyConfig();
    expect(() => setConfigValue(config, 'bogus', 'x')).toThrow(/unknown config key/i);
  });

  it('set on sources.<url>.policy throws when the source is not in config', () => {
    const config = emptyConfig();
    expect(() =>
      setConfigValue(config, 'sources.git@example.com:missing/x.git.policy', 'latest'),
    ).toThrow(/unknown source/i);
  });
});

describe('invalid values', () => {
  it('rejects a non-enum syncPolicy', () => {
    const config = emptyConfig();
    expect(() => setConfigValue(config, 'syncPolicy', 'foo')).toThrow(/invalid value/i);
  });

  it('rejects a non-boolean autoAccept', () => {
    const config = emptyConfig();
    expect(() => setConfigValue(config, 'autoAccept', 'maybe')).toThrow(/invalid value/i);
  });

  it('rejects a non-enum per-source policy', () => {
    const config = emptyConfig();
    config.sources.push({ url: 'git@example.com:a/a.git' });
    expect(() =>
      setConfigValue(config, 'sources.git@example.com:a/a.git.policy', 'occasionally'),
    ).toThrow(/invalid value/i);
  });
});

describe('reset', () => {
  it('reset() with no arg clears every v0.1.1 field and every per-source policy', () => {
    const config: CcppConfig = {
      version: 1,
      scope: 'user',
      syncPolicy: 'latest',
      autoAccept: true,
      policyAcknowledgedAt: '2026-04-23T12:00:00Z',
      autoAcceptAcknowledgedAt: '2026-04-23T12:05:00Z',
      sources: [{ url: 'git@example.com:a/a.git', policy: 'latest' }],
    };
    resetConfigValue(config);
    expect(config.syncPolicy).toBeUndefined();
    expect(config.autoAccept).toBeUndefined();
    expect(config.policyAcknowledgedAt).toBeUndefined();
    expect(config.autoAcceptAcknowledgedAt).toBeUndefined();
    expect(config.sources[0]!.policy).toBeUndefined();
    // Must not wipe sources themselves:
    expect(config.sources).toHaveLength(1);
    // Defaults are now effective:
    expect(getConfigValue(config, 'syncPolicy')).toBe('pinned');
    expect(getConfigValue(config, 'autoAccept')).toBe(false);
  });

  it('reset(<key>) resets only that key', () => {
    const config: CcppConfig = {
      version: 1,
      scope: 'user',
      syncPolicy: 'latest',
      autoAccept: true,
      sources: [{ url: 'git@example.com:a/a.git', policy: 'latest' }],
    };
    resetConfigValue(config, 'syncPolicy');
    expect(config.syncPolicy).toBeUndefined();
    expect(config.autoAccept).toBe(true);
    expect(config.sources[0]!.policy).toBe('latest');
  });

  it('reset(<sources.url.policy>) drops only that source override', () => {
    const config: CcppConfig = {
      version: 1,
      scope: 'user',
      sources: [
        { url: 'git@example.com:a/a.git', policy: 'latest' },
        { url: 'git@example.com:b/b.git', policy: 'latest' },
      ],
    };
    resetConfigValue(config, 'sources.git@example.com:a/a.git.policy');
    expect(config.sources[0]!.policy).toBeUndefined();
    expect(config.sources[1]!.policy).toBe('latest');
  });

  it('reset on an unknown key throws', () => {
    const config = emptyConfig();
    expect(() => resetConfigValue(config, 'bogus')).toThrow(/unknown config key/i);
  });
});

describe('listConfig', () => {
  it('flags defaults and surfaces per-source rows', () => {
    const config: CcppConfig = {
      version: 1,
      scope: 'user',
      syncPolicy: 'latest',
      sources: [
        { url: 'git@example.com:a/a.git' },
        { url: 'git@example.com:b/b.git', policy: 'pinned' },
      ],
    };
    const rows = listConfig(config);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['syncPolicy']).toEqual({ key: 'syncPolicy', value: 'latest', isDefault: false });
    expect(byKey['autoAccept']).toEqual({ key: 'autoAccept', value: false, isDefault: true });
    expect(byKey['sources.git@example.com:a/a.git.policy']).toEqual({
      key: 'sources.git@example.com:a/a.git.policy',
      value: undefined,
      isDefault: true,
    });
    expect(byKey['sources.git@example.com:b/b.git.policy']).toEqual({
      key: 'sources.git@example.com:b/b.git.policy',
      value: 'pinned',
      isDefault: false,
    });
  });
});
