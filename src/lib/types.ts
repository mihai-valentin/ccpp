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
  /** Manifest schema version — used for forward-compat migrations. */
  version: number;
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
 * The `ccpp.lock` file — pins every manifest source to a concrete commit
 * and records the integrity metadata needed to detect drift.
 */
export interface Lockfile {
  /** Lockfile schema version. */
  version: number;
  /** Entries keyed by source short alias. */
  entries: Record<string, LockEntry>;
  /** ISO-8601 timestamp when the lockfile was last written. */
  generatedAt: string;
}

/**
 * A single pinned entry inside a {@link Lockfile}.
 */
export interface LockEntry {
  /** Source URL. */
  url: string;
  /** Pinned commit SHA. */
  commit: string;
  /** Optional ref originally requested (for audit / human readability). */
  ref?: string;
  /** Optional content-hash of the fetched tree for integrity checks. */
  integrity?: string;
}
