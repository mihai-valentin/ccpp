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
 * Describes a single plugin bundle within a source — a cohesive
 * collection of skills and/or slash commands shipped together.
 */
export interface PluginManifest {
  /** Short name of the plugin (used as command prefix in Claude Code). */
  name: string;
  /** Human-readable description. */
  description?: string;
  /** Skills exposed by this plugin. */
  skills?: Skill[];
  /** Slash commands exposed by this plugin. */
  commands?: SlashCommand[];
}

/**
 * A single Claude Code skill definition as distributed by ccpp.
 * Metadata only — the actual skill body lives on disk as a SKILL.md file.
 */
export interface Skill {
  /** Skill short name. */
  name: string;
  /** Path (relative to plugin root) to the SKILL.md file. */
  path: string;
  /** One-line description shown in skill listings. */
  description?: string;
}

/**
 * A single Claude Code slash command definition.
 * Metadata only — the command body lives on disk as a markdown file.
 */
export interface SlashCommand {
  /** Command short name, without the leading slash. */
  name: string;
  /** Path (relative to plugin root) to the command definition file. */
  path: string;
  /** One-line description shown in command listings. */
  description?: string;
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
