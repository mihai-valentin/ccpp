import { promises as fs } from 'node:fs';

export const CONFIG_FILENAME = 'ccpp.config.json';

export type SyncPolicy = 'pinned' | 'latest';
export const SYNC_POLICIES: readonly SyncPolicy[] = ['pinned', 'latest'] as const;

export interface ConfigSource {
  url: string;
  ref?: string;
  policy?: SyncPolicy;
}

export interface CcppConfig {
  version: 1;
  sources: ConfigSource[];
  scope: 'user';
  preferredSources?: Record<string, string>;
  syncPolicy?: SyncPolicy;
  autoAccept?: boolean;
  policyAcknowledgedAt?: string;
  autoAcceptAcknowledgedAt?: string;
}

export const CONFIG_DEFAULTS = {
  syncPolicy: 'pinned' as SyncPolicy,
  autoAccept: false,
} as const;

export interface ConfigEntry {
  key: string;
  value: unknown;
  isDefault: boolean;
}

export function emptyConfig(): CcppConfig {
  return { version: 1, sources: [], scope: 'user' };
}

export async function configExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(path: string): Promise<CcppConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read config ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse config ${path}: ${(err as Error).message}`);
  }
  return validate(parsed, path);
}

export async function writeConfig(path: string, config: CcppConfig): Promise<void> {
  await fs.writeFile(path, `${stableStringify(config)}\n`, 'utf8');
}

function validate(raw: unknown, path: string): CcppConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid config ${path}: expected a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== 1) {
    throw new Error(
      `Unsupported config version at ${path}: expected 1, got ${JSON.stringify(obj['version'])}.`,
    );
  }
  const sources = obj['sources'];
  if (!Array.isArray(sources)) {
    throw new Error(`Invalid config ${path}: "sources" must be an array.`);
  }
  const normalisedSources: ConfigSource[] = [];
  for (const [i, entry] of sources.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid config ${path}: sources[${i}] must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['url'] !== 'string' || e['url'].length === 0) {
      throw new Error(`Invalid config ${path}: sources[${i}].url must be a non-empty string.`);
    }
    const ref = e['ref'];
    if (ref !== undefined && typeof ref !== 'string') {
      throw new Error(`Invalid config ${path}: sources[${i}].ref must be a string if set.`);
    }
    const policy = e['policy'];
    if (policy !== undefined && !isSyncPolicy(policy)) {
      throw new Error(
        `Invalid config ${path}: sources[${i}].policy must be one of ${SYNC_POLICIES.join(', ')} if set.`,
      );
    }
    const source: ConfigSource = { url: e['url'] };
    if (ref !== undefined) source.ref = ref;
    if (policy !== undefined) source.policy = policy;
    normalisedSources.push(source);
  }
  const scope = obj['scope'] ?? 'user';
  if (scope !== 'user') {
    throw new Error(
      `Invalid config ${path}: "scope" must be "user" (got ${JSON.stringify(scope)}).`,
    );
  }
  const preferredSources = obj['preferredSources'];
  let normalisedPreferred: Record<string, string> | undefined;
  if (preferredSources !== undefined) {
    if (
      !preferredSources ||
      typeof preferredSources !== 'object' ||
      Array.isArray(preferredSources)
    ) {
      throw new Error(`Invalid config ${path}: "preferredSources" must be an object.`);
    }
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(preferredSources as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(
          `Invalid config ${path}: preferredSources["${k}"] must be a string.`,
        );
      }
      map[k] = v;
    }
    normalisedPreferred = map;
  }

  const syncPolicy = obj['syncPolicy'];
  if (syncPolicy !== undefined && !isSyncPolicy(syncPolicy)) {
    throw new Error(
      `Invalid config ${path}: "syncPolicy" must be one of ${SYNC_POLICIES.join(', ')} if set.`,
    );
  }
  const autoAccept = obj['autoAccept'];
  if (autoAccept !== undefined && typeof autoAccept !== 'boolean') {
    throw new Error(`Invalid config ${path}: "autoAccept" must be a boolean if set.`);
  }
  const policyAcknowledgedAt = obj['policyAcknowledgedAt'];
  if (policyAcknowledgedAt !== undefined && typeof policyAcknowledgedAt !== 'string') {
    throw new Error(`Invalid config ${path}: "policyAcknowledgedAt" must be a string if set.`);
  }
  const autoAcceptAcknowledgedAt = obj['autoAcceptAcknowledgedAt'];
  if (autoAcceptAcknowledgedAt !== undefined && typeof autoAcceptAcknowledgedAt !== 'string') {
    throw new Error(
      `Invalid config ${path}: "autoAcceptAcknowledgedAt" must be a string if set.`,
    );
  }

  const config: CcppConfig = { version: 1, sources: normalisedSources, scope: 'user' };
  if (normalisedPreferred !== undefined) config.preferredSources = normalisedPreferred;
  if (syncPolicy !== undefined) config.syncPolicy = syncPolicy as SyncPolicy;
  if (autoAccept !== undefined) config.autoAccept = autoAccept;
  if (policyAcknowledgedAt !== undefined) config.policyAcknowledgedAt = policyAcknowledgedAt;
  if (autoAcceptAcknowledgedAt !== undefined) {
    config.autoAcceptAcknowledgedAt = autoAcceptAcknowledgedAt;
  }
  return config;
}

function isSyncPolicy(v: unknown): v is SyncPolicy {
  return typeof v === 'string' && (SYNC_POLICIES as readonly string[]).includes(v);
}

type ParsedKey =
  | { kind: 'syncPolicy' }
  | { kind: 'autoAccept' }
  | { kind: 'policyAcknowledgedAt' }
  | { kind: 'autoAcceptAcknowledgedAt' }
  | { kind: 'sourcePolicy'; url: string };

const KNOWN_TOP_LEVEL_KEYS = [
  'syncPolicy',
  'autoAccept',
  'policyAcknowledgedAt',
  'autoAcceptAcknowledgedAt',
] as const;

function parseKey(key: string): ParsedKey | null {
  switch (key) {
    case 'syncPolicy':
      return { kind: 'syncPolicy' };
    case 'autoAccept':
      return { kind: 'autoAccept' };
    case 'policyAcknowledgedAt':
      return { kind: 'policyAcknowledgedAt' };
    case 'autoAcceptAcknowledgedAt':
      return { kind: 'autoAcceptAcknowledgedAt' };
  }
  if (key.startsWith('sources.') && key.endsWith('.policy')) {
    const url = key.slice('sources.'.length, key.length - '.policy'.length);
    if (url.length > 0) return { kind: 'sourcePolicy', url };
  }
  return null;
}

function unknownKeyError(key: string): Error {
  return new Error(
    `Unknown config key "${key}". Known keys: ${KNOWN_TOP_LEVEL_KEYS.join(', ')}, sources.<url>.policy.`,
  );
}

/**
 * Return the effective value for a config key.
 * Defaults are applied for `syncPolicy` and `autoAccept`;
 * `policyAcknowledgedAt` / `autoAcceptAcknowledgedAt` / per-source `policy` return
 * undefined when unset (no default). Throws on unknown keys.
 */
export function getConfigValue(config: CcppConfig, key: string): unknown {
  const parsed = parseKey(key);
  if (!parsed) throw unknownKeyError(key);
  switch (parsed.kind) {
    case 'syncPolicy':
      return config.syncPolicy ?? CONFIG_DEFAULTS.syncPolicy;
    case 'autoAccept':
      return config.autoAccept ?? CONFIG_DEFAULTS.autoAccept;
    case 'policyAcknowledgedAt':
      return config.policyAcknowledgedAt;
    case 'autoAcceptAcknowledgedAt':
      return config.autoAcceptAcknowledgedAt;
    case 'sourcePolicy': {
      const src = config.sources.find((s) => s.url === parsed.url);
      if (!src) {
        throw new Error(
          `Unknown source "${parsed.url}". Add it via \`ccpp install\` before setting per-source policy.`,
        );
      }
      return src.policy;
    }
  }
}

/**
 * Coerce a raw string value and write it into the config object.
 * Mutates `config` in place; the caller is responsible for persisting it.
 * Throws on unknown keys or invalid values.
 */
export function setConfigValue(config: CcppConfig, key: string, rawValue: string): void {
  const parsed = parseKey(key);
  if (!parsed) throw unknownKeyError(key);
  switch (parsed.kind) {
    case 'syncPolicy': {
      config.syncPolicy = coerceSyncPolicy(key, rawValue);
      return;
    }
    case 'autoAccept': {
      config.autoAccept = coerceBoolean(key, rawValue);
      return;
    }
    case 'policyAcknowledgedAt': {
      config.policyAcknowledgedAt = rawValue;
      return;
    }
    case 'autoAcceptAcknowledgedAt': {
      config.autoAcceptAcknowledgedAt = rawValue;
      return;
    }
    case 'sourcePolicy': {
      const src = config.sources.find((s) => s.url === parsed.url);
      if (!src) {
        throw new Error(
          `Unknown source "${parsed.url}". Add it via \`ccpp install\` before setting per-source policy.`,
        );
      }
      src.policy = coerceSyncPolicy(key, rawValue);
      return;
    }
  }
}

/**
 * Reset a single key (if provided) or all v0.1.1 policy fields (if omitted).
 * Mutates `config` in place. Never touches `sources` / `preferredSources` / `version` / `scope`.
 * Throws on unknown keys.
 */
export function resetConfigValue(config: CcppConfig, key?: string): void {
  if (key === undefined) {
    delete config.syncPolicy;
    delete config.autoAccept;
    delete config.policyAcknowledgedAt;
    delete config.autoAcceptAcknowledgedAt;
    for (const src of config.sources) delete src.policy;
    return;
  }
  const parsed = parseKey(key);
  if (!parsed) throw unknownKeyError(key);
  switch (parsed.kind) {
    case 'syncPolicy':
      delete config.syncPolicy;
      return;
    case 'autoAccept':
      delete config.autoAccept;
      return;
    case 'policyAcknowledgedAt':
      delete config.policyAcknowledgedAt;
      return;
    case 'autoAcceptAcknowledgedAt':
      delete config.autoAcceptAcknowledgedAt;
      return;
    case 'sourcePolicy': {
      const src = config.sources.find((s) => s.url === parsed.url);
      if (!src) {
        throw new Error(
          `Unknown source "${parsed.url}". Add it via \`ccpp install\` before resetting per-source policy.`,
        );
      }
      delete src.policy;
      return;
    }
  }
}

/**
 * Flatten config into a list of {key, value, isDefault} entries covering all v0.1.1 keys
 * plus a `sources.<url>.policy` row for every configured source (whether set or not).
 */
export function listConfig(config: CcppConfig): ConfigEntry[] {
  const entries: ConfigEntry[] = [
    {
      key: 'syncPolicy',
      value: config.syncPolicy ?? CONFIG_DEFAULTS.syncPolicy,
      isDefault: config.syncPolicy === undefined,
    },
    {
      key: 'autoAccept',
      value: config.autoAccept ?? CONFIG_DEFAULTS.autoAccept,
      isDefault: config.autoAccept === undefined,
    },
    {
      key: 'policyAcknowledgedAt',
      value: config.policyAcknowledgedAt,
      isDefault: config.policyAcknowledgedAt === undefined,
    },
    {
      key: 'autoAcceptAcknowledgedAt',
      value: config.autoAcceptAcknowledgedAt,
      isDefault: config.autoAcceptAcknowledgedAt === undefined,
    },
  ];
  for (const src of config.sources) {
    entries.push({
      key: `sources.${src.url}.policy`,
      value: src.policy,
      isDefault: src.policy === undefined,
    });
  }
  return entries;
}

function coerceSyncPolicy(key: string, raw: string): SyncPolicy {
  if (isSyncPolicy(raw)) return raw;
  throw new Error(
    `Invalid value for "${key}": expected one of ${SYNC_POLICIES.join(', ')}, got ${JSON.stringify(raw)}.`,
  );
}

function coerceBoolean(key: string, raw: string): boolean {
  const normalised = raw.trim().toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  throw new Error(
    `Invalid value for "${key}": expected "true" or "false", got ${JSON.stringify(raw)}.`,
  );
}

function stableStringify(value: unknown, indent = 0): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const nextIndent = indent + 2;
    const pad = ' '.repeat(nextIndent);
    const end = ' '.repeat(indent);
    const items = value.map((v) => `${pad}${stableStringify(v, nextIndent)}`);
    return `[\n${items.join(',\n')}\n${end}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (keys.length === 0) return '{}';
    const nextIndent = indent + 2;
    const pad = ' '.repeat(nextIndent);
    const end = ' '.repeat(indent);
    const entries = keys.map((k) => {
      const v = (value as Record<string, unknown>)[k];
      return `${pad}${JSON.stringify(k)}: ${stableStringify(v, nextIndent)}`;
    });
    return `{\n${entries.join(',\n')}\n${end}}`;
  }
  return 'null';
}
