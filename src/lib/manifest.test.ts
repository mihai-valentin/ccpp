import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../tests/fixtures/manifest');

describe('parseManifest', () => {
  it('loads plugins declared in a valid marketplace.json', async () => {
    const result = await parseManifest(join(FIXTURES, 'marketplace-present'));

    expect(result.marketplaceName).toBe('Example Marketplace');
    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0]!;
    expect(plugin.name).toBe('example-plugin');
    expect(plugin.version).toBe('1.2.3');
    expect(plugin.description).toBe('A sample plugin listed in marketplace.json');
    expect(plugin.author).toEqual({ name: 'Example Author' });
    expect(plugin.commands.map((c) => c.name)).toEqual(['hello']);
    expect(plugin.commands[0]!.sourceFile).toContain('hello.md');
    expect(plugin.skills).toEqual([]);
    expect(result.standaloneCommands).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('falls back to a convention scan when marketplace.json is absent', async () => {
    const result = await parseManifest(join(FIXTURES, 'convention-only'));

    expect(result.marketplaceName).toBeUndefined();
    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0]!;
    expect(plugin.name).toBe('example');
    expect(plugin.dir).toContain(join('plugins', 'example'));
    expect(plugin.commands.map((c) => c.name)).toEqual(['bar']);
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.skills[0]!.name).toBe('baz');
    expect(plugin.skills[0]!.files.some((f) => f.endsWith('SKILL.md'))).toBe(true);
    expect(plugin.skills[0]!.files.some((f) => f.endsWith('helper.txt'))).toBe(true);
  });

  it('discovers standalone commands under the repo-level commands/ directory', async () => {
    const result = await parseManifest(join(FIXTURES, 'convention-only'));

    expect(result.standaloneCommands.map((c) => c.name)).toEqual(['standalone']);
    expect(result.standaloneCommands[0]!.sourceFile).toContain('standalone.md');
  });

  it('parses the exact ai-plugins-dev shape (commands/ + plugins/<two>/) cleanly via convention scan', async () => {
    const result = await parseManifest(join(FIXTURES, 'ai-plugins-dev-shape'));

    const names = result.plugins.map((p) => p.name).sort();
    expect(names).toEqual(['ai-pr-workflow', 'git-conflict-resolver']);

    const prWorkflow = result.plugins.find((p) => p.name === 'ai-pr-workflow')!;
    expect(prWorkflow.commands.map((c) => c.name)).toEqual(['pr']);
    expect(prWorkflow.skills.map((s) => s.name)).toEqual(['pr-review']);

    const conflictResolver = result.plugins.find((p) => p.name === 'git-conflict-resolver')!;
    expect(conflictResolver.commands.map((c) => c.name)).toEqual(['resolve']);
    expect(conflictResolver.skills).toEqual([]);

    expect(result.standaloneCommands.map((c) => c.name)).toEqual(['root-only']);
    expect(result.warnings).toEqual([]);
  });

  it('throws a descriptive error mentioning the file path when plugin.json is missing a required field', async () => {
    const fixture = join(FIXTURES, 'invalid-plugin-schema');
    await expect(parseManifest(fixture)).rejects.toThrow(/plugin\.json/);
    await expect(parseManifest(fixture)).rejects.toThrow(/version/);
    await expect(parseManifest(fixture)).rejects.toThrow(
      /missing-version[\\/]\.claude-plugin[\\/]plugin\.json/,
    );
  });

  it('throws a descriptive JSON-parse error mentioning the file path when plugin.json is malformed', async () => {
    const fixture = join(FIXTURES, 'invalid-plugin-json');
    await expect(parseManifest(fixture)).rejects.toThrow(/Failed to parse JSON/);
    await expect(parseManifest(fixture)).rejects.toThrow(/plugin\.json/);
  });

  it('throws when two plugins share the same name', async () => {
    const fixture = join(FIXTURES, 'duplicate-plugin');
    await expect(parseManifest(fixture)).rejects.toThrow(/Duplicate plugin name "same-name"/);
  });

  it('warns (does not throw) when a standalone command name collides with a plugin-scoped command', async () => {
    const result = await parseManifest(join(FIXTURES, 'command-collision'));

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe('command-name-collision');
    expect(result.warnings[0]!.message).toContain('dup');
    // Still returns everything it parsed.
    expect(result.plugins.map((p) => p.name)).toEqual(['p']);
    expect(result.standaloneCommands.map((c) => c.name)).toEqual(['dup']);
  });

  it('throws when the source directory does not exist', async () => {
    await expect(parseManifest(join(FIXTURES, 'does-not-exist'))).rejects.toThrow(
      /Source directory does not exist/,
    );
  });
});
