import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Changeset, computeChangeset, hasChanges } from './diff.js';
import { applyManifest } from './installer.js';
import { emptyLockfile } from './lockfile.js';
import type { Lockfile, ResolvedManifest } from './types.js';

let scratch: string;
let claudeHome: string;
let sourceRoot: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-diff-'));
  claudeHome = join(scratch, 'claude');
  sourceRoot = join(scratch, 'source');
  await fs.mkdir(claudeHome, { recursive: true });
  await fs.mkdir(sourceRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function writeSourceFile(relPath: string, content: string): Promise<string> {
  const abs = join(sourceRoot, relPath);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

async function writeDestFile(relPath: string, content: string): Promise<string> {
  const abs = join(claudeHome, relPath);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

function buildManifest(overrides: Partial<ResolvedManifest> = {}): ResolvedManifest {
  return {
    sourceDir: sourceRoot,
    standaloneCommands: [],
    plugins: [],
    ...overrides,
  };
}

describe('computeChangeset', () => {
  it('(1) returns an empty change set when every file is already in sync', async () => {
    const src = await writeSourceFile('commands/hello.md', 'hello body');
    await writeDestFile('commands/hello.md', 'hello body');
    const lockfile: Lockfile = emptyLockfile();
    lockfile.installed[join(claudeHome, 'commands/hello.md')] = {
      sourceUrl: 'https://x/one.git',
      sourcePath: 'commands/hello.md',
      sourceSha: 'sha-1',
      installedAt: '2026-04-23T00:00:00Z',
    };

    const cs = await computeChangeset({
      manifest: buildManifest({ standaloneCommands: [{ name: 'hello', sourceFile: src }] }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });

    expect(hasChanges(cs)).toBe(false);
    expect(cs).toEqual<Changeset>({
      added: [],
      modified: [],
      removed: [],
      unchanged: [join(claudeHome, 'commands/hello.md')],
    });
  });

  it('(2) added-only: new command from a source with no prior lockfile entries', async () => {
    const src = await writeSourceFile('commands/new.md', 'body');

    const cs = await computeChangeset({
      manifest: buildManifest({ standaloneCommands: [{ name: 'new', sourceFile: src }] }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile: emptyLockfile(),
    });

    expect(hasChanges(cs)).toBe(true);
    expect(cs.added).toEqual([join(claudeHome, 'commands/new.md')]);
    expect(cs.modified).toEqual([]);
    expect(cs.removed).toEqual([]);
    expect(cs.unchanged).toEqual([]);
  });

  it('(3) modified-only: dest exists with different bytes', async () => {
    const src = await writeSourceFile('commands/hello.md', 'v2 body');
    await writeDestFile('commands/hello.md', 'v1 body');
    const lockfile: Lockfile = emptyLockfile();
    lockfile.installed[join(claudeHome, 'commands/hello.md')] = {
      sourceUrl: 'https://x/one.git',
      sourcePath: 'commands/hello.md',
      sourceSha: 'sha-old',
      installedAt: '2026-04-20T00:00:00Z',
    };

    const cs = await computeChangeset({
      manifest: buildManifest({ standaloneCommands: [{ name: 'hello', sourceFile: src }] }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });

    expect(cs.added).toEqual([]);
    expect(cs.modified).toEqual([join(claudeHome, 'commands/hello.md')]);
    expect(cs.removed).toEqual([]);
    expect(cs.unchanged).toEqual([]);
  });

  it('(4) removed-only: lockfile entry with no corresponding manifest plan item', async () => {
    const lockfile: Lockfile = emptyLockfile();
    const orphanDest = join(claudeHome, 'commands/gone.md');
    lockfile.installed[orphanDest] = {
      sourceUrl: 'https://x/one.git',
      sourcePath: 'commands/gone.md',
      sourceSha: 'sha-old',
      installedAt: '2026-04-20T00:00:00Z',
    };

    const cs = await computeChangeset({
      manifest: buildManifest({ standaloneCommands: [] }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });

    expect(cs.added).toEqual([]);
    expect(cs.modified).toEqual([]);
    expect(cs.removed).toEqual([orphanDest]);
    expect(cs.unchanged).toEqual([]);
  });

  it('(5) mixed: added + modified + removed + unchanged in one pass', async () => {
    const newSrc = await writeSourceFile('commands/new.md', 'new body');
    const modSrc = await writeSourceFile('commands/mod.md', 'v2');
    const sameSrc = await writeSourceFile('commands/same.md', 'same');
    await writeDestFile('commands/mod.md', 'v1');
    await writeDestFile('commands/same.md', 'same');
    const lockfile: Lockfile = emptyLockfile();
    const gone = join(claudeHome, 'commands/gone.md');
    for (const dest of [join(claudeHome, 'commands/mod.md'), join(claudeHome, 'commands/same.md'), gone]) {
      lockfile.installed[dest] = {
        sourceUrl: 'https://x/one.git',
        sourcePath: dest.slice(claudeHome.length + 1),
        sourceSha: 'sha-old',
        installedAt: '2026-04-20T00:00:00Z',
      };
    }

    const cs = await computeChangeset({
      manifest: buildManifest({
        standaloneCommands: [
          { name: 'new', sourceFile: newSrc },
          { name: 'mod', sourceFile: modSrc },
          { name: 'same', sourceFile: sameSrc },
        ],
      }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });

    expect(cs.added).toEqual([join(claudeHome, 'commands/new.md')]);
    expect(cs.modified).toEqual([join(claudeHome, 'commands/mod.md')]);
    expect(cs.removed).toEqual([gone]);
    expect(cs.unchanged).toEqual([join(claudeHome, 'commands/same.md')]);
    expect(hasChanges(cs)).toBe(true);
  });

  it('refuses to compare bytes of a source file that is a symlink', async () => {
    // Mirror of installer.test.ts — defense-in-depth: even if a symlink
    // slipped past manifest.walkFiles, computeChangeset must refuse to
    // read it (otherwise the diff preview would leak target bytes).
    const realTarget = await writeSourceFile('real.md', 'target bytes');
    const linkPath = join(sourceRoot, 'commands', 'evil.md');
    await fs.mkdir(dirname(linkPath), { recursive: true });
    // Dest has to exist for the read-and-compare branch to be reached.
    await writeDestFile('commands/evil.md', 'dest bytes');
    await fs.symlink(realTarget, linkPath);

    await expect(
      computeChangeset({
        manifest: buildManifest({ standaloneCommands: [{ name: 'evil', sourceFile: linkPath }] }),
        sourceUrl: 'https://x/one.git',
        sourceSha: 'sha-1',
        claudeHome,
        lockfile: emptyLockfile(),
      }),
    ).rejects.toThrow(/refusing to read symlink/i);
  });

  it('(6) destPaths match what applyManifest would produce (commands + plugin skills)', async () => {
    const helloSrc = await writeSourceFile('commands/hello.md', 'hello body');
    const prSrc = await writeSourceFile('plugins/pr/commands/pr.md', 'pr body');
    const skillMd = await writeSourceFile('plugins/pr/skills/pr-review/SKILL.md', 'skill body');
    const skillRef = await writeSourceFile(
      'plugins/pr/skills/pr-review/references/style.md',
      'style notes',
    );

    const manifest = buildManifest({
      standaloneCommands: [{ name: 'hello', sourceFile: helloSrc }],
      plugins: [
        {
          name: 'pr',
          version: '0.1.0',
          description: 'pr plugin',
          dir: join(sourceRoot, 'plugins/pr'),
          commands: [{ name: 'pr', sourceFile: prSrc }],
          skills: [
            {
              name: 'pr-review',
              sourceDir: join(sourceRoot, 'plugins/pr/skills/pr-review'),
              files: [skillMd, skillRef],
            },
          ],
        },
      ],
    });

    const cs = await computeChangeset({
      manifest,
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile: emptyLockfile(),
    });

    // All destinations are "added" since claudeHome is empty.
    expect(cs.added.sort()).toEqual(
      [
        join(claudeHome, 'commands/hello.md'),
        join(claudeHome, 'commands/pr.md'),
        join(claudeHome, 'skills/pr-review/SKILL.md'),
        join(claudeHome, 'skills/pr-review/references/style.md'),
      ].sort(),
    );

    // Now apply and confirm installer.applyManifest writes exactly those dests.
    const lockfile: Lockfile = emptyLockfile();
    const applyResult = await applyManifest({
      manifest,
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });
    expect(applyResult.installed.sort()).toEqual(cs.added);
  });
});
