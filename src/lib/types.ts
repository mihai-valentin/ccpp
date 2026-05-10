/**
 * A source of skills or slash commands, referenced by the manifest.
 * Typically a git repository (private or public) identified by a URL
 * and an optional ref (branch, tag, or commit).
 */
export interface Source {
  /** Short alias used to refer to this source from the manifest. */
  name: string;
  /** Git URL (https or ssh) or other supported fetch URL. */
  url: string;
  /** Optional ref — branch, tag, or commit SHA. Defaults to the repo's default branch. */
  ref?: string;
  /** Optional subdirectory within the repo to treat as the source root. */
  subpath?: string;
}

/**
 * A {@link Source} after it has been resolved to a concrete commit SHA.
 * Produced during a sync / install step and recorded in the lockfile.
 */
export interface ResolvedSource extends Source {
  /** Fully-resolved commit SHA the source was pinned to. */
  commit: string;
  /** ISO-8601 timestamp when the source was last resolved. */
  resolvedAt: string;
}

/**
 * The top-level `ccpp.json` manifest describing which sources to pull
 * skills and slash commands from, plus install preferences.
 */
export interface Manifest {
  /** Manifest schema version. Bump when introducing breaking shape changes. */
  version: 1;
  /** Named sources keyed by short alias. */
  sources: Record<string, Source>;
  /** Optional list of plugin short names to enable. */
  plugins?: string[];
}

/**
 * A single Claude Code slash command definition discovered inside a source
 * repository. Produced by the manifest parser.
 */
export interface SlashCommand {
  /** Command short name, without the leading slash. Derived from the file basename. */
  name: string;
  /** Absolute path to the backing `.md` file on disk. */
  sourceFile: string;
}

/**
 * A single Claude Code subagent discovered inside a source repository.
 * Agents are flat single-file definitions: a markdown file with frontmatter
 * (name, description, tools, model) plus a system-prompt body. They install
 * to `~/.claude/agents/<name>.md` and are auto-discovered by Claude Code.
 */
export interface Agent {
  /** Agent short name. Derived from the file basename (no `.md`). */
  name: string;
  /** Absolute path to the backing `.md` file on disk. */
  sourceFile: string;
}

/**
 * A single Claude Code skill discovered inside a source repository.
 * A skill is a directory containing `SKILL.md` and, optionally, supporting files.
 */
export interface Skill {
  /** Skill short name. Derived from the enclosing directory. */
  name: string;
  /** Absolute path to the skill's root directory. */
  sourceDir: string;
  /** Absolute paths of every file contained in the skill directory (recursive). */
  files: string[];
}

/**
 * A plugin discovered inside a source repository.
 */
export interface PluginManifest {
  /** Short name of the plugin (used as command prefix in Claude Code). */
  name: string;
  /** Semver string declared in the plugin's `plugin.json`. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** Optional author info. */
  author?: string | { name: string };
  /** Absolute path to the plugin's root directory. */
  dir: string;
  /** Slash commands exposed by this plugin. */
  commands: SlashCommand[];
  /** Skills exposed by this plugin. */
  skills: Skill[];
  /** Subagents exposed by this plugin. */
  agents: Agent[];
}

/**
 * Result of {@link parseManifest} — a repo's plugins and standalone commands
 * resolved from either a `.claude-plugin/marketplace.json` or a convention scan.
 */
export interface ResolvedManifest {
  /** Absolute path to the source repository root. */
  sourceDir: string;
  /** Marketplace display name when loaded from `marketplace.json`; undefined for convention scans. */
  marketplaceName?: string;
  /** Plugins declared by the source repo. */
  plugins: PluginManifest[];
  /** Top-level slash commands not bound to any plugin (from `commands/*.md` at repo root). */
  standaloneCommands: SlashCommand[];
  /** Top-level skills not bound to any plugin (from `skills/<name>/SKILL.md` at repo root). */
  standaloneSkills: Skill[];
  /** Top-level subagents not bound to any plugin (from `agents/*.md` at repo root). */
  standaloneAgents: Agent[];
}

/**
 * Raw shape of a repo-level `.claude-plugin/marketplace.json`, validated by the parser.
 */
export interface MarketplaceJson {
  name?: string;
  owner?: string | { name?: string };
  plugins?: Array<{ name: string; source: string; description?: string }>;
}

/**
 * Raw shape of a per-plugin `.claude-plugin/plugin.json`, validated by the parser.
 */
export interface PluginJson {
  name: string;
  version: string;
  description: string;
  author?: string | { name: string };
  keywords?: string[];
}

/**
 * The `ccpp.lock.json` file — pins every synced source to a concrete commit
 * and records every file that has been written into `~/.claude/` so the next
 * sync can diff, skip, overwrite, or uninstall correctly.
 */
export interface Lockfile {
  /** Lockfile schema version. */
  version: 1;
  /** Per-source pin, keyed by git URL. */
  sources: Record<string, LockSourceEntry>;
  /** Per-file install record, keyed by destination path under the Claude home. */
  installed: Record<string, LockInstalledEntry>;
}

/**
 * A single pinned source inside a {@link Lockfile}.
 */
export interface LockSourceEntry {
  /** Commit SHA the source is pinned to. */
  sha: string;
  /** Human-readable ref (branch or tag) at the time of the last sync. */
  ref: string;
  /** ISO-8601 timestamp when the source was last synced. */
  lastSync: string;
}

/**
 * A single installed destination inside a {@link Lockfile}.
 * `destPath` is the lockfile key; this is the value.
 */
export interface LockInstalledEntry {
  /** URL of the source this file came from. */
  sourceUrl: string;
  /** Path of the file within the source repo, relative to `ResolvedManifest.sourceDir` (the clone root). */
  sourcePath: string;
  /** SHA of the source at the time of install, for drift detection. */
  sourceSha: string;
  /** ISO-8601 timestamp when the file was installed. */
  installedAt: string;
}

/**
 * A collision surfaced when two sources attempt to install the same
 * destination. The CLI layer asks the user to resolve via `--prefer <source>`.
 */
export interface Conflict {
  /** Absolute destination path under the Claude home. */
  destPath: string;
  /** URL of the source currently owning `destPath` per the lockfile. */
  currentSourceUrl: string;
  /** URL of the source attempting to overwrite it. */
  incomingSourceUrl: string;
  /** Short name (command, skill, or agent) that collided. */
  name: string;
}
