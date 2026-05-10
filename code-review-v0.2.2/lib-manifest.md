# Module: src/lib/manifest.ts

**LoC**: 374  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/lib/manifest.test.ts` (152 LoC)  •  **v0.2.2 status**: refactored

## Purpose
Read-side of ccpp: take a cloned source repo on disk and produce a `ResolvedManifest` describing every plugin, command, skill, and agent it exposes. Two parsing strategies — `.claude-plugin/marketplace.json` if present, else a convention scan of `plugins/<name>/` and top-level `commands/`, `skills/`, `agents/`. Validates `plugin.json` schema and surfaces command/skill/agent name collisions as warnings.

## Public surface
- **Types**: `ParseManifestWarning` (with `code: 'command-name-collision' | 'skill-name-collision' | 'agent-name-collision'`), `ParseManifestResult`.
- **Functions**: `parseManifest()` (only export).

## Strengths
- **The v0.2.1 high-priority asymmetry is closed**: `scanStandaloneSkills` (241–243) now exists alongside `scanStandaloneCommands` (197–199) and `scanStandaloneAgents` (205–207). A top-level `skills/` directory is scanned, surfaced through `ResolvedManifest.standaloneSkills`, and propagated through `lib/plan.ts:planFiles` into the apply pipeline.
- **Skill-name-collision detection added** (306–323): mirrors the existing command and agent collision detectors. `ParseManifestWarning.code` now includes `'skill-name-collision'` (18). The three detectors share a structural pattern (286–342).
- **`pathExists` deduplication closed**: imported from `lib/fsutil.ts` (line 3); no longer duplicated against `installer.ts`.
- **`assertDirectory` errno-aware**: line 349–356 now distinguishes ENOENT ("does not exist") from other errors (EACCES, ELOOP, etc.), surfacing the real reason instead of mislabelling everything as missing. Closes the v0.2.1 medium finding.
- **Strategy split unchanged and clear**: `loadFromMarketplace` vs `scanConventionPlugins` (65–100). Tested both paths.
- **Convention scan tolerates missing dirs gracefully**: `pathExists` guards at 36, 89, 96, 210, 224, 246, 253. No error on absent `plugins/`, `commands/`, `skills/`, `agents/`.
- **Sorted outputs for determinism preserved**: 219, 233, 257, 272.
- **Schema validation strict but reasonable**: `KEBAB_CASE` (14) + `SEMVER` (15) + structural checks for `author`, `keywords`. Test fixtures live on disk.

## Concerns

### Cohesion
The module does one thing — parse a source repo into a `ResolvedManifest` — but it bundles three sub-concerns: strategy dispatch, per-file scanners, and JSON schema validation. At 374 LoC it's at the upper edge for a single file. The v0.2.1 suggestion to split into `manifest/scan.ts` + `manifest/validate.ts` is still on the table. Not urgent.

### Coupling
- Imports `node:fs`, `node:path`, `lib/fsutil` (1–3), and 7 named types from `lib/types.js`. Clean.
- No dependence on `commands/*` or `cli.ts`. Direction is correct.
- Doesn't depend on `fsutil.readFileSafe` for the convention scan; the actual read happens later in `installer.ts` through that helper. Design intent could be made explicit in the module docstring.

### Maintainability
- **Significant remaining duplication in the scanners.** `scanCommandsDir` (223–235) and `scanAgentsDir` (209–221) are byte-equivalent except variable names and return type. v0.2.1 high suggestion to collapse into a generic `scanFlatMdDir<T>(dir, factory)` is still open. The same shape repeats:
  ```ts
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -'.md'.length);
    items.push({ name, sourceFile: join(dir, entry.name) });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  ```
- **Duplication tripled, not halved**: the v0.2.1 review predicted that adding `scanStandaloneSkills` would happen but flagged the existing duplication. v0.2.2 added the new scanner, but the underlying 4-arm pattern wasn't generalised. There are now six paper-thin wrappers (`scanPluginCommands`/`scanStandaloneCommands`/`scanPluginAgents`/`scanStandaloneAgents`/`scanPluginSkills`/`scanStandaloneSkills`, 193–243), each calling the same `scanXxxDir` with one of two paths.
- **Three near-identical collision detectors** (287–342): `detectCommandCollisions`, `detectSkillCollisions`, `detectAgentCollisions`. Same structure, only the field name and warning code differ:
  ```ts
  const standaloneNames = new Set(standalone<X>.map(x => x.name));
  for (const plugin of plugins) {
    for (const item of plugin.<x>s) {
      if (standaloneNames.has(item.name)) {
        warnings.push({ code: '<x>-name-collision', message: ... });
      }
    }
  }
  ```
  v0.2.1 high suggestion to collapse these into one generic was not adopted; instead a third near-identical copy was added.
- **`validatePluginJson` (124–191)** still 67 lines of repetitive `typeof`/`Array.isArray` ladders. v0.2.1 medium suggestion to factor an `assertString(obj, key, ctx)` helper or pull in zod — unfixed.
- **`walkFiles` (261–274)** still recursive and unbounded. Skill trees are shallow in practice; flagging as defensive.
- **`KEBAB_CASE` enforcement asymmetric**: still applied only to plugin names (134), not skill/command/agent names. Skill names come from directory names (255), command/agent names from file basenames (216, 230) — neither validated. Document or enforce.
- **`keywords` (175–182)** still validated but not exposed on `PluginManifest`. Dead validation. v0.2.1 finding unchanged.
- **`marketplaceName`** still exposed on `ResolvedManifest` but never consumed downstream. Dead-but-harmless.

### Style
- **Doc-comments are present** but the top-level function comment (26–30) doesn't describe the new standalone-skills behavior. Worth a one-line update.
- **Magic string repetitions**: `'.md'` (215, 216, 229, 230), `'SKILL.md'` (252), `'plugin.json'` (95, 104), `'.claude-plugin'` (35, 95, 104), `'marketplace.json'` (35) — none centralised. Could live in a `LAYOUT` const adjacent to `lib/layout.CLAUDE_LAYOUT`.
- **`assertDirectory` (344–360)** now has a tight error-routing implementation. The `errno === 'ENOENT'` branch is the common case, the catch-all surfaces the real `Error.message` for everything else. Good.
- **`loadFromMarketplace`'s entry validation (73–77)** still doesn't validate `entry.name` — only `entry.source`. v0.2.1 noted this. Fine if name is optional; document otherwise.

## Specific issues
- **lib/manifest.ts:193–207, 237–243**: six paper-thin wrappers (`scanPluginCommands`/`scanStandaloneCommands`/`scanPluginAgents`/`scanStandaloneAgents`/`scanPluginSkills`/`scanStandaloneSkills`) — over-factored. Inline the `join` at the call sites and call the underlying scanner directly.
- **lib/manifest.ts:209–235**: `scanCommandsDir` and `scanAgentsDir` are byte-equivalent. Collapse into `scanFlatMdDir<T>(dir, factory: (name, file) => T): Promise<T[]>`.
- **lib/manifest.ts:287–342**: three near-identical collision detectors. Collapse into `detectCollisions<T>(plugins, standalone, accessor: PluginManifest => T[], code, label)` or similar. The new skill detector triples the duplication rather than refactoring.
- **lib/manifest.ts:124–191**: `validatePluginJson` is 67 lines of repetitive `typeof` ladders, with the same `Invalid plugin.json at ${filePath}: missing required field "X"` template repeated. Factor a small validator helper or pull in zod.
- **lib/manifest.ts:175–182**: `keywords` validation is dead — `PluginManifest` doesn't expose it. Either expose or remove.
- **lib/manifest.ts:14, 134**: `KEBAB_CASE` enforced for plugin names only. Skill, command, agent names are accepted as-is. Either enforce uniformly or document the asymmetry.
- **lib/manifest.ts:261–274**: `walkFiles` is unbounded recursion. Fine for shallow skill trees but defensible to switch to iterative.
- **lib/manifest.ts:73–77**: marketplace `entry.name` is not validated. Fine if optional; otherwise add a check.
- **lib/manifest.ts:26–30**: doc-comment doesn't mention standalone skills (only `plugins/` and top-level `commands/`). Update to reflect the new behavior.

## Suggestions
- **[high]** Collapse the six scanner wrappers (193–243) and the two flat-md scanners (209–235) into one generic `scanFlatMdDir<T>(dir, factory)`. Eliminates ~30 lines and ensures any future fix lands in commands and agents simultaneously.
- **[high]** Collapse the three collision detectors (287–342) into one generic. The fact that v0.2.2 *added* a third copy instead of generalising is a sign the duplication has cost the project work.
- **[medium]** Replace `validatePluginJson` (124–191) with a small validator helper or zod. The current ladder is hard to maintain when adding optional fields.
- **[medium]** Decide and act on `keywords` (175–182): either expose on `PluginManifest` or remove the validation.
- **[low]** Centralise file-layout strings (`'plugin.json'`, `'.claude-plugin'`, `'marketplace.json'`, `'SKILL.md'`, `'.md'`) in a `LAYOUT` const adjacent to `lib/layout.CLAUDE_LAYOUT`.
- **[low]** Either enforce `KEBAB_CASE` for skill/command/agent names too, or document the regex as plugin-name-only.
- **[low]** Update the top-level doc comment (26–30) to mention standalone skills.
- **[low]** Switch `walkFiles` to an iterative stack-based walk for defensive depth resilience.
