import { promises as fs } from 'node:fs';

export const CONFIG_FILENAME = 'ccpp.config.json';

export interface ConfigSource {
  url: string;
  ref?: string;
}

export interface CcppConfig {
  version: 1;
  sources: ConfigSource[];
  scope: 'user';
  preferredSources?: Record<string, string>;
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
    const source: ConfigSource = { url: e['url'] };
    if (ref !== undefined) source.ref = ref;
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
  const config: CcppConfig = { version: 1, sources: normalisedSources, scope: 'user' };
  if (normalisedPreferred !== undefined) config.preferredSources = normalisedPreferred;
  return config;
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
