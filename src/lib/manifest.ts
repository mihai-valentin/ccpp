import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathExists } from './fsutil.js';
import type {
  Agent,
  MarketplaceJson,
  PluginJson,
  PluginManifest,
  ResolvedManifest,
  Skill,
  SlashCommand,
} from './types.js';

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParseManifestWarning {
  code: 'command-name-collision' | 'skill-name-collision' | 'agent-name-collision';
  message: string;
}

export interface ParseManifestResult extends ResolvedManifest {
  warnings: ParseManifestWarning[];
}

/**
 * Parse a source repository's manifest. Reads
 * `<sourceDir>/.claude-plugin/marketplace.json` when present; otherwise falls
 * back to a convention scan of `plugins/` and top-level `commands/`.
 */
export async function parseManifest(sourceDir: string): Promise<ParseManifestResult> {
  const absSource = resolve(sourceDir);
  await assertDirectory(absSource);

  const marketplacePath = join(absSource, '.claude-plugin', 'marketplace.json');
  const hasMarketplace = await pathExists(marketplacePath);

  const { marketplaceName, plugins } = hasMarketplace
    ? await loadFromMarketplace(absSource, marketplacePath)
    : { marketplaceName: undefined, plugins: await scanConventionPlugins(absSource) };

  assertUniquePluginNames(plugins);

  const standaloneCommands = await scanStandaloneCommands(absSource);
  const standaloneSkills = await scanStandaloneSkills(absSource);
  const standaloneAgents = await scanStandaloneAgents(absSource);

  const warnings = [
    ...detectCommandCollisions(plugins, standaloneCommands),
    ...detectSkillCollisions(plugins, standaloneSkills),
    ...detectAgentCollisions(plugins, standaloneAgents),
  ];

  return {
    sourceDir: absSource,
    marketplaceName,
    plugins,
    standaloneCommands,
    standaloneSkills,
    standaloneAgents,
    warnings,
  };
}

async function loadFromMarketplace(
  sourceDir: string,
  marketplacePath: string,
): Promise<{ marketplaceName: string | undefined; plugins: PluginManifest[] }> {
  const raw = await readJson<MarketplaceJson>(marketplacePath);
  const list = Array.isArray(raw.plugins) ? raw.plugins : [];
  const plugins: PluginManifest[] = [];
  for (const entry of list) {
    if (!entry || typeof entry.source !== 'string' || entry.source.length === 0) {
      throw new Error(
        `Invalid plugin entry in ${marketplacePath}: each entry must declare a "source" path.`,
      );
    }
    const pluginDir = isAbsolute(entry.source) ? entry.source : resolve(sourceDir, entry.source);
    plugins.push(await loadPluginFromDir(pluginDir));
  }
  return {
    marketplaceName: typeof raw.name === 'string' ? raw.name : undefined,
    plugins,
  };
}

async function scanConventionPlugins(sourceDir: string): Promise<PluginManifest[]> {
  const pluginsRoot = join(sourceDir, 'plugins');
  if (!(await pathExists(pluginsRoot))) return [];
  const entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  const plugins: PluginManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(pluginsRoot, entry.name);
    const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (!(await pathExists(pluginJsonPath))) continue;
    plugins.push(await loadPluginFromDir(pluginDir));
  }
  return plugins;
}

async function loadPluginFromDir(pluginDir: string): Promise<PluginManifest> {
  await assertDirectory(pluginDir);
  const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json');
  const raw = await readJson<Record<string, unknown>>(pluginJsonPath);
  const validated = validatePluginJson(raw, pluginJsonPath);

  const commands = await scanPluginCommands(pluginDir);
  const skills = await scanPluginSkills(pluginDir);
  const agents = await scanPluginAgents(pluginDir);

  return {
    name: validated.name,
    version: validated.version,
    description: validated.description,
    author: validated.author,
    dir: pluginDir,
    commands,
    skills,
    agents,
  };
}

function validatePluginJson(raw: unknown, filePath: string): PluginJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid plugin.json at ${filePath}: expected a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;

  const name = obj.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Invalid plugin.json at ${filePath}: missing required field "name".`);
  }
  if (!KEBAB_CASE.test(name)) {
    throw new Error(
      `Invalid plugin.json at ${filePath}: "name" must be kebab-case (got ${JSON.stringify(name)}).`,
    );
  }

  const version = obj.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`Invalid plugin.json at ${filePath}: missing required field "version".`);
  }
  if (!SEMVER.test(version)) {
    throw new Error(
      `Invalid plugin.json at ${filePath}: "version" must be semver (got ${JSON.stringify(version)}).`,
    );
  }

  const description = obj.description;
  if (typeof description !== 'string') {
    throw new Error(`Invalid plugin.json at ${filePath}: missing required field "description".`);
  }

  const author = obj.author;
  let normalizedAuthor: PluginJson['author'];
  if (author === undefined) {
    normalizedAuthor = undefined;
  } else if (typeof author === 'string') {
    normalizedAuthor = author;
  } else if (author && typeof author === 'object' && !Array.isArray(author)) {
    const authorName = (author as Record<string, unknown>).name;
    if (typeof authorName !== 'string') {
      throw new Error(
        `Invalid plugin.json at ${filePath}: "author" object must have a "name" string.`,
      );
    }
    normalizedAuthor = { name: authorName };
  } else {
    throw new Error(
      `Invalid plugin.json at ${filePath}: "author" must be a string or an object with a "name".`,
    );
  }

  const keywords = obj.keywords;
  let normalizedKeywords: string[] | undefined;
  if (keywords !== undefined) {
    if (!Array.isArray(keywords) || keywords.some((k) => typeof k !== 'string')) {
      throw new Error(`Invalid plugin.json at ${filePath}: "keywords" must be string[].`);
    }
    normalizedKeywords = keywords as string[];
  }

  return {
    name,
    version,
    description,
    author: normalizedAuthor,
    keywords: normalizedKeywords,
  };
}

async function scanPluginCommands(pluginDir: string): Promise<SlashCommand[]> {
  return scanCommandsDir(join(pluginDir, 'commands'));
}

async function scanStandaloneCommands(sourceDir: string): Promise<SlashCommand[]> {
  return scanCommandsDir(join(sourceDir, 'commands'));
}

async function scanPluginAgents(pluginDir: string): Promise<Agent[]> {
  return scanAgentsDir(join(pluginDir, 'agents'));
}

async function scanStandaloneAgents(sourceDir: string): Promise<Agent[]> {
  return scanAgentsDir(join(sourceDir, 'agents'));
}

async function scanAgentsDir(dir: string): Promise<Agent[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const agents: Agent[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -'.md'.length);
    agents.push({ name, sourceFile: join(dir, entry.name) });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}

async function scanCommandsDir(dir: string): Promise<SlashCommand[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -'.md'.length);
    commands.push({ name, sourceFile: join(dir, entry.name) });
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}

async function scanPluginSkills(pluginDir: string): Promise<Skill[]> {
  return scanSkillsDir(join(pluginDir, 'skills'));
}

async function scanStandaloneSkills(sourceDir: string): Promise<Skill[]> {
  return scanSkillsDir(join(sourceDir, 'skills'));
}

async function scanSkillsDir(skillsRoot: string): Promise<Skill[]> {
  if (!(await pathExists(skillsRoot))) return [];
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsRoot, entry.name);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!(await pathExists(skillFile))) continue;
    const files = await walkFiles(skillDir);
    skills.push({ name: entry.name, sourceDir: skillDir, files });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  out.sort();
  return out;
}

function assertUniquePluginNames(plugins: PluginManifest[]): void {
  const seen = new Map<string, string>();
  for (const p of plugins) {
    const prev = seen.get(p.name);
    if (prev !== undefined) {
      throw new Error(`Duplicate plugin name "${p.name}" — found in both ${prev} and ${p.dir}.`);
    }
    seen.set(p.name, p.dir);
  }
}

function detectCommandCollisions(
  plugins: PluginManifest[],
  standaloneCommands: SlashCommand[],
): ParseManifestWarning[] {
  const standaloneNames = new Set(standaloneCommands.map((c) => c.name));
  const warnings: ParseManifestWarning[] = [];
  for (const plugin of plugins) {
    for (const cmd of plugin.commands) {
      if (standaloneNames.has(cmd.name)) {
        warnings.push({
          code: 'command-name-collision',
          message: `Command "${cmd.name}" exists as both a standalone command and inside plugin "${plugin.name}".`,
        });
      }
    }
  }
  return warnings;
}

function detectSkillCollisions(
  plugins: PluginManifest[],
  standaloneSkills: Skill[],
): ParseManifestWarning[] {
  const standaloneNames = new Set(standaloneSkills.map((s) => s.name));
  const warnings: ParseManifestWarning[] = [];
  for (const plugin of plugins) {
    for (const skill of plugin.skills) {
      if (standaloneNames.has(skill.name)) {
        warnings.push({
          code: 'skill-name-collision',
          message: `Skill "${skill.name}" exists as both a standalone skill and inside plugin "${plugin.name}".`,
        });
      }
    }
  }
  return warnings;
}

function detectAgentCollisions(
  plugins: PluginManifest[],
  standaloneAgents: Agent[],
): ParseManifestWarning[] {
  const standaloneNames = new Set(standaloneAgents.map((a) => a.name));
  const warnings: ParseManifestWarning[] = [];
  for (const plugin of plugins) {
    for (const agent of plugin.agents) {
      if (standaloneNames.has(agent.name)) {
        warnings.push({
          code: 'agent-name-collision',
          message: `Agent "${agent.name}" exists as both a standalone agent and inside plugin "${plugin.name}".`,
        });
      }
    }
  }
  return warnings;
}

async function assertDirectory(path: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(path);
  } catch {
    throw new Error(`Source directory does not exist: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${path}`);
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${(err as Error).message}`);
  }
}
