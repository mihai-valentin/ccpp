# Module: src/lib/manifest.ts

**LoC**: 347  •  **Test file**: yes — `/home/mihai/xlnf/ccpp/src/lib/manifest.test.ts`

## Purpose
Read-side of ccpp: take a cloned source repo on disk and produce a `ResolvedManifest` describing every plugin, command, skill, and agent it exposes. Two parsing strategies — `.claude-plugin/marketplace.json` if present, else a convention scan of `plugins/<name>/` and top-level `commands/` / `agents/`. Validates `plugin.json` schema and surfaces command/agent name collisions as warnings (not errors).

## Public surface
- Types: `ParseManifestWarning` (with `code: 'command-name-collision' | 'agent-name-collision'`), `ParseManifestResult`
- Constants: none exported (KEBAB_CASE, SEMVER are file-local)
- Functions: `parseManifest()` (only export)
- Internal helpers: `loadFromMarketplace`, `scanConventionPlugins`, `loadPluginFromDir`, `validatePluginJson`, `scanPluginCommands`, `scanStandaloneCommands`, `scanPluginAgents`, `scanStandaloneAgents`, `scanAgentsDir`, `scanCommandsDir`, `scanPluginSkills`, `walkFiles`, `assertUniquePluginNames`, `detectCommandCollisions`, `detectAgentCollisions`, `pathExists`, `assertDirectory`, `readJson`

## Strengths
- **Clear strategy split**: `loadFromMarketplace` vs `scanConventionPlugins` (lines 61-96) — one entry-point picks one path, no mixing. Test at manifest.test.ts:10-42 exercises both.
- **Convention scan tolerates missing dirs gracefully**: `pathExists` guards at lines 85, 206, 220, 235, 242 mean "no `plugins/`" or "no `commands/`" or "no `SKILL.md`" all reduce to an empty array, not an error. Matches the ai-plugins-dev fixture shape exactly (test at manifest.test.ts:51-68).
- **Descriptive errors that name the file**: `validatePluginJson` errors all include `${filePath}` (lines 122-167), matching the test expectations at manifest.test.ts:96-103.
- **Schema validation is strict but reasonable**: `KEBAB_CASE` and `SEMVER` (lines 13-14) plus structural checks for `author`, `keywords` (lines 151-178). Wrong-shape inputs throw with a precise reason.
- **Collision detection is symmetric for commands and agents** (lines 276-312): two near-identical helpers, same warning shape, same coverage in tests (manifest.test.ts:85-94, 116-125).
- **Sorted outputs for determinism**: `commands.sort()` (line 229), `agents.sort()` (line 215), `skills.sort()` (line 246), `walkFiles` sorts (line 261). Important for reproducible installs.
- **Test fixtures live on disk**, not as JS objects. Real I/O is exercised, not mocked.

## Concerns
### Cohesion
The module does one thing — parse a source repo into a `ResolvedManifest` — but it bundles three sub-concerns: the strategy dispatch, the per-file scanners (commands/agents/skills), and the schema validator. At 347 LoC it is at the upper edge of readability for a single file. A possible split: `manifest.ts` (entry + strategy), `manifest/scan.ts` (the scanners), `manifest/validate.ts` (the JSON validator). Not urgent.

### Coupling
- Imports `node:fs`, `node:path`, and 7 named types from `./types.js` (lines 1-11). Clean.
- Does not import any `commands/*` or `cli.ts` symbol — correct direction.
- Does not depend on `fsutil.readFileSafe` even though it walks files from a partially-trusted source. **This is fine in the current design** because `walkFiles` (line 250-263) only emits paths via `Dirent.isFile()` (which is false for symlinks on most platforms — readdir returns `isSymbolicLink()` for them), and the actual read happens later in `installer.ts` through `readFileSafe`. But the design intent could be documented.

### Maintainability
- `validatePluginJson` (lines 120-187) is 67 lines of repetitive `typeof` checks. Could be replaced with Zod or a small `assertString(obj, key, fileFmt)` helper to drop ~30 lines. Today, the same `Invalid plugin.json at ${filePath}: missing required field "X".` template is written 3+ times (lines 128, 138, 148).
- **Significant copy-paste between `scanCommandsDir` and `scanAgentsDir`** (lines 205-217 vs 219-231). They are byte-equivalent except for the local-variable name (`commands` vs `agents`) and the return type. A single `scanFlatMdDir<T>(dir, ctor: ({name, sourceFile}) => T)` would collapse them.
- Likewise `scanPluginCommands` / `scanStandaloneCommands` (lines 189-195) and `scanPluginAgents` / `scanStandaloneAgents` (lines 197-203) are paper-thin wrappers — four functions that each call the same `scanXxxDir` with one of two paths. Could be inlined (the call sites in `parseManifest` and `loadPluginFromDir` would just do the `join`).
- **`detectCommandCollisions` and `detectAgentCollisions` are also near-duplicates** (lines 276-312). Same loop, same warning shape, only the field name (`commands` vs `agents`) and the warning code/message string differ. A single generic `detectCollisions(plugins, standalone, accessor, code, label)` would deduplicate.
- `pathExists` (lines 314-321) is duplicated in `installer.ts:258-265`. Belongs in `fsutil.ts`.
- `walkFiles` (lines 250-263) is recursive and unbounded — a maliciously-deep skill directory could blow the stack. In practice skill trees are shallow; flagging only as a defensive note.
- `assertDirectory` (lines 323-333) catches the stat error and re-wraps it as "Source directory does not exist" — even if the actual error is `EACCES`. Misleading message in the rare permission-denied case.
- `KEBAB_CASE` regex (line 13) requires kebab-case for the **plugin name** but not for command, skill, or agent names. Skill names come from a directory name (line 244) and agent/command names from file basenames — neither validated. Inconsistent.
- Magic string `'.md'` repeated at lines 211, 212, 225, 226 (and `slice(0, -'.md'.length)` is awkward). A `MD_EXT = '.md'` constant + `basename(name, MD_EXT)` would be clearer.
- Magic string `'SKILL.md'` (line 241) and `'plugin.json'` (lines 91, 100) and `'.claude-plugin'` (lines 34, 91, 100) are uncentralised. Centralising in a `LAYOUT` constant would document the file format invariants in one place.

### Style
- Doc-comments on the top-level function (lines 25-29) accurately describe the dispatch.
- The interface declarations at lines 16-23 (`ParseManifestWarning`, `ParseManifestResult`) are right-sized.
- `PluginJson` is imported (line 5) but its `keywords` field is parsed and validated (lines 171-178) into a return value — yet the resulting `PluginManifest` (in `types.ts`) doesn't expose `keywords`. Dead validation logic; the keywords array is checked but then never read by any caller. (Verified: grep of `keywords` across `src/` shows it is only set in `validatePluginJson` and never consumed.)
- Same for `marketplaceName` — exposed on `ResolvedManifest`, returned by `parseManifest`, but `cli.ts`/`installer.ts` never read it. Dead-but-harmless.
- The `await readJson<MarketplaceJson>` cast (line 65) trusts the type; if `marketplace.json` isn't shaped right, the loop at line 68 catches the worst case (`!entry || typeof entry.source !== 'string'`) but the `name` field at line 78 is also assumed-safe-once-typeof-checked. OK.
- Line 269: `seen.set(p.name, p.dir)` — the value is the dir, then used in the error message at line 270. Good: the user gets both colliding paths.

## Specific issues
- `src/lib/manifest.ts:120-187` — `validatePluginJson` is 67 lines of mostly repetitive `typeof`/`Array.isArray` ladders. Same error template repeated. Either factor an `assertString(obj, key, ctx)` helper or pull in a schema lib (zod).
- `src/lib/manifest.ts:171-178` — `keywords` is parsed and validated but never returned to a consumer (`PluginManifest` in `types.ts:81-98` doesn't expose it). Dead validation.
- `src/lib/manifest.ts:189-195, 197-203` — four-function ladder (`scanPluginCommands`, `scanStandaloneCommands`, `scanPluginAgents`, `scanStandaloneAgents`) is over-factored. Inline the `join(...)` at the two call sites.
- `src/lib/manifest.ts:205-231` — `scanCommandsDir` and `scanAgentsDir` are byte-equivalent except for the variable name. Collapse into a generic `scanFlatMdDir<T>(dir, factory)`.
- `src/lib/manifest.ts:276-312` — `detectCommandCollisions` and `detectAgentCollisions` are near-identical. Collapse into one generic helper.
- `src/lib/manifest.ts:314-321` — `pathExists` duplicates `installer.ts:258-265`. Move to `fsutil.ts`.
- `src/lib/manifest.ts:323-333` — `assertDirectory` swallows the underlying `fs.stat` error message; on EACCES the user sees "Source directory does not exist", which is wrong.
- `src/lib/manifest.ts:13` — `KEBAB_CASE` is enforced for plugin names only. Skill names (line 244) and command/agent names (file basenames, lines 213, 227) are accepted as-is. If the project requires kebab-case throughout, the validation is asymmetric. If not, the regex constant should be documented as plugin-name-only.
- `src/lib/manifest.ts:233-248` — `scanPluginSkills` only looks under `plugins/<p>/skills/`. There is **no `scanStandaloneSkills`** — i.e. a top-level `skills/` directory at the repo root is silently ignored. Compare to commands and agents, which have both standalone and plugin variants. This is asymmetric: standalone commands and agents work; standalone skills do not. If that's a deliberate design choice, document it; if not, it's a bug.
- `src/lib/manifest.ts:250-263` — `walkFiles` is unbounded recursion. In a worst-case adversarial source, a deeply nested skill directory could exhaust the stack. Switch to an iterative stack-based walk if you want to be defensive.
- `src/lib/manifest.ts:261` — `out.sort()` sorts each subtree's results before they're concatenated; the parent then sees pre-sorted children, but the final aggregate order is not lexicographic across subtrees (it's depth-first). Test at installer.test.ts:88 sorts both sides explicitly, so this hasn't bitten yet, but if any caller assumes globally-sorted file order, document or change.
- `src/lib/manifest.ts:78` — `marketplaceName: typeof raw.name === 'string' ? raw.name : undefined` — the field is exposed on `ResolvedManifest` but never consumed downstream. Dead-but-harmless; confirm intent.
- `src/lib/manifest.ts:69` — error path checks `!entry || typeof entry.source !== 'string' || entry.source.length === 0` but does not validate `entry.name`. The marketplace fixture at `tests/fixtures/manifest/marketplace-present` ships a `name`, so it's never tested. If `name` is required, validate it; if optional, no action.
- `src/lib/manifest.ts:265-274` — `assertUniquePluginNames` throws a plain `Error`, not a typed `EnvError`. Caller at `cli.ts:223-225` wraps in `EnvError` so the exit code is right, but the policy is implicit.

## Suggestions
- **[high]** Decide and document the standalone-skills story. Either add `scanStandaloneSkills` (mirroring `scanStandaloneCommands` and `scanStandaloneAgents`) and surface it in `ResolvedManifest`, or document in the doc-comment of `parseManifest` that "skills must live under `plugins/<p>/skills/`; a top-level `skills/` directory is ignored." Today the asymmetry is silent.
- **[high]** Collapse the four near-duplicates: `scanCommandsDir`/`scanAgentsDir` → one generic; `detectCommandCollisions`/`detectAgentCollisions` → one generic. Eliminates ~50 lines and ensures any future fix lands in both.
- **[high]** Move `pathExists` to `fsutil.ts` (also fixes the same duplication in `installer.ts:258-265`).
- **[medium]** Replace `validatePluginJson` (lines 120-187) with a tiny schema helper or zod. The current ladder is hard to maintain when adding new optional fields.
- **[medium]** Fix `assertDirectory`'s misleading error: include `(err as Error).message` so EACCES is distinguishable from ENOENT.
- **[medium]** Document or remove the unused `keywords` validation (line 171-178) and `marketplaceName` (line 78). If they're roadmap items, leave a `// TODO(0.3): expose keywords on PluginManifest` comment.
- **[low]** Centralise the file-layout strings (`'plugin.json'`, `'.claude-plugin'`, `'marketplace.json'`, `'SKILL.md'`, `'.md'`) in a `LAYOUT` const.
- **[low]** Switch `walkFiles` to iterative for defensive-depth resilience.
- **[low]** Either enforce `KEBAB_CASE` for skill, command, and agent names too, or document the regex as plugin-name-only.
