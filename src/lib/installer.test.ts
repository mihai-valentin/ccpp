import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyManifest, removeFromLockfile } from './installer.js';
import { emptyLockfile } from './lockfile.js';
import type { Lockfile, ResolvedManifest } from './types.js';

let scratch: string;
let claudeHome: string;
let sourceRoot: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'ccpp-install-'));
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

function buildManifest(overrides: Partial<ResolvedManifest> = {}): ResolvedManifest {
  return {
    sourceDir: sourceRoot,
    standaloneCommands: [],
    standaloneSkills: [],
    standaloneAgents: [],
    plugins: [],
    ...overrides,
  };
}

async function read(path: string): Promise<string> {
  return fs.readFile(path, 'utf8');
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await fs.readdir(path)).sort();
  } catch {
    return [];
  }
}

describe('applyManifest', () => {
  it('writes standalone commands, plugin commands (flat), and skill trees into claudeHome', async () => {
    const helloSrc = await writeSourceFile('commands/hello.md', 'hello body');
    const prSrc = await writeSourceFile('plugins/pr/commands/pr.md', 'pr body');
    const skillMd = await writeSourceFile('plugins/pr/skills/pr-review/SKILL.md', 'skill body');
    const skillRef = await writeSourceFile(
      'plugins/pr/skills/pr-review/references/style.md',
      'style notes',
    );

    const lockfile: Lockfile = emptyLockfile();
    const result = await applyManifest({
      manifest: buildManifest({
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
            agents: [],
          },
        ],
      }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });

    expect(result.installed.sort()).toEqual(
      [
        join(claudeHome, 'commands/hello.md'),
        join(claudeHome, 'commands/pr.md'),
        join(claudeHome, 'skills/pr-review/SKILL.md'),
        join(claudeHome, 'skills/pr-review/references/style.md'),
      ].sort(),
    );
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.backups).toEqual([]);

    expect(await read(join(claudeHome, 'commands/hello.md'))).toBe('hello body');
    expect(await read(join(claudeHome, 'commands/pr.md'))).toBe('pr body');
    expect(await read(join(claudeHome, 'skills/pr-review/SKILL.md'))).toBe('skill body');
    expect(await read(join(claudeHome, 'skills/pr-review/references/style.md'))).toBe(
      'style notes',
    );

    const entry = lockfile.installed[join(claudeHome, 'commands/hello.md')]!;
    expect(entry.sourceUrl).toBe('https://x/one.git');
    expect(entry.sourceSha).toBe('sha-1');
    expect(entry.sourcePath).toBe(join('commands', 'hello.md'));
    expect(entry.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes standalone agents and plugin agents into claudeHome/agents/', async () => {
    const triageSrc = await writeSourceFile('agents/triage.md', 'triage body');
    const reviewerSrc = await writeSourceFile(
      'plugins/pr/agents/pr-reviewer.md',
      'pr-reviewer body',
    );

    const lockfile: Lockfile = emptyLockfile();
    const result = await applyManifest({
      manifest: buildManifest({
        standaloneAgents: [{ name: 'triage', sourceFile: triageSrc }],
        plugins: [
          {
            name: 'pr',
            version: '0.1.0',
            description: 'pr plugin',
            dir: join(sourceRoot, 'plugins/pr'),
            commands: [],
            skills: [],
            agents: [{ name: 'pr-reviewer', sourceFile: reviewerSrc }],
          },
        ],
      }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });

    expect(result.installed.sort()).toEqual(
      [
        join(claudeHome, 'agents', 'triage.md'),
        join(claudeHome, 'agents', 'pr-reviewer.md'),
      ].sort(),
    );
    expect(result.conflicts).toEqual([]);
    expect(await listDir(join(claudeHome, 'agents'))).toEqual(['pr-reviewer.md', 'triage.md']);
    expect(await read(join(claudeHome, 'agents', 'triage.md'))).toBe('triage body');
    expect(await read(join(claudeHome, 'agents', 'pr-reviewer.md'))).toBe('pr-reviewer body');

    const triageEntry = lockfile.installed[join(claudeHome, 'agents', 'triage.md')]!;
    expect(triageEntry.sourcePath).toBe(join('agents', 'triage.md'));
    expect(triageEntry.sourceUrl).toBe('https://x/one.git');
  });

  it('surfaces a Conflict when two sources want the same agent dest', async () => {
    const a = await writeSourceFile('agents/triage.md', 'A body');
    const lockfile: Lockfile = emptyLockfile();
    await applyManifest({
      manifest: buildManifest({
        standaloneAgents: [{ name: 'triage', sourceFile: a }],
      }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-A',
      claudeHome,
      lockfile,
    });

    const b = await writeSourceFile('agents/triage.md', 'B body');
    const result = await applyManifest({
      manifest: buildManifest({
        standaloneAgents: [{ name: 'triage', sourceFile: b }],
      }),
      sourceUrl: 'https://x/two.git',
      sourceSha: 'sha-B',
      claudeHome,
      lockfile,
    });

    expect(result.installed).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.name).toBe('triage');
    expect(result.conflicts[0]!.destPath).toBe(join(claudeHome, 'agents', 'triage.md'));
    // Existing-source bytes are untouched.
    expect(await read(join(claudeHome, 'agents', 'triage.md'))).toBe('A body');
  });

  it('is a no-op on a clean re-install (everything reported as unchanged)', async () => {
    const helloSrc = await writeSourceFile('commands/hello.md', 'hello body');
    const lockfile: Lockfile = emptyLockfile();
    const opts = {
      manifest: buildManifest({ standaloneCommands: [{ name: 'hello', sourceFile: helloSrc }] }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    };

    await applyManifest(opts);
    const second = await applyManifest(opts);

    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.backups).toEqual([]);
    expect(second.unchanged).toEqual([join(claudeHome, 'commands/hello.md')]);
  });

  it('backs up and overwrites a destination whose bytes differ from the source', async () => {
    const helloSrc = await writeSourceFile('commands/hello.md', 'v1');
    const lockfile: Lockfile = emptyLockfile();
    const opts = {
      manifest: buildManifest({ standaloneCommands: [{ name: 'hello', sourceFile: helloSrc }] }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    };
    await applyManifest(opts);

    // Upstream advances.
    await fs.writeFile(helloSrc, 'v2');
    const second = await applyManifest({ ...opts, sourceSha: 'sha-2' });

    const destPath = join(claudeHome, 'commands/hello.md');
    expect(second.updated).toEqual([destPath]);
    expect(second.backups).toHaveLength(1);
    expect(second.backups[0]!).toMatch(/hello\.md\.bak\.\d{4}-\d{2}-\d{2}T/);
    expect(second.backups[0]!).not.toContain(':');
    expect(await read(destPath)).toBe('v2');
    expect(await read(second.backups[0]!)).toBe('v1');

    expect(lockfile.installed[destPath]!.sourceSha).toBe('sha-2');
  });

  it('returns a Conflict (no write) when a second source wants the same destination', async () => {
    const srcA = await writeSourceFile('a/commands/git-commit.md', 'from-A');
    const srcB = await writeSourceFile('b/commands/git-commit.md', 'from-B');
    const lockfile: Lockfile = emptyLockfile();

    await applyManifest({
      manifest: buildManifest({ standaloneCommands: [{ name: 'git-commit', sourceFile: srcA }] }),
      sourceUrl: 'https://a.git',
      sourceSha: 'a1',
      claudeHome,
      lockfile,
    });

    const second = await applyManifest({
      manifest: buildManifest({ standaloneCommands: [{ name: 'git-commit', sourceFile: srcB }] }),
      sourceUrl: 'https://b.git',
      sourceSha: 'b1',
      claudeHome,
      lockfile,
    });

    const destPath = join(claudeHome, 'commands/git-commit.md');
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]).toEqual({
      destPath,
      currentSourceUrl: 'https://a.git',
      incomingSourceUrl: 'https://b.git',
      name: 'git-commit',
    });
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.backups).toEqual([]);
    // Disk still has A's content, lockfile still points at A.
    expect(await read(destPath)).toBe('from-A');
    expect(lockfile.installed[destPath]!.sourceUrl).toBe('https://a.git');
  });

  it('resolves a collision when preferredSources picks the incoming source (preferred wins, backup created)', async () => {
    const srcA = await writeSourceFile('a/commands/git-commit.md', 'from-A');
    const srcB = await writeSourceFile('b/commands/git-commit.md', 'from-B');
    const lockfile: Lockfile = emptyLockfile();

    await applyManifest({
      manifest: buildManifest({ standaloneCommands: [{ name: 'git-commit', sourceFile: srcA }] }),
      sourceUrl: 'https://a.git',
      sourceSha: 'a1',
      claudeHome,
      lockfile,
    });

    const second = await applyManifest({
      manifest: buildManifest({ standaloneCommands: [{ name: 'git-commit', sourceFile: srcB }] }),
      sourceUrl: 'https://b.git',
      sourceSha: 'b1',
      claudeHome,
      lockfile,
      preferredSources: { 'git-commit': 'https://b.git' },
    });

    const destPath = join(claudeHome, 'commands/git-commit.md');
    expect(second.conflicts).toEqual([]);
    expect(second.updated).toEqual([destPath]);
    expect(second.backups).toHaveLength(1);
    expect(await read(destPath)).toBe('from-B');
    expect(lockfile.installed[destPath]!.sourceUrl).toBe('https://b.git');
  });

  it('resolves a collision when preferredSources picks the existing source (incoming silently skipped)', async () => {
    const srcA = await writeSourceFile('a/commands/git-commit.md', 'from-A');
    const srcB = await writeSourceFile('b/commands/git-commit.md', 'from-B');
    const lockfile: Lockfile = emptyLockfile();

    await applyManifest({
      manifest: buildManifest({ standaloneCommands: [{ name: 'git-commit', sourceFile: srcA }] }),
      sourceUrl: 'https://a.git',
      sourceSha: 'a1',
      claudeHome,
      lockfile,
    });

    const second = await applyManifest({
      manifest: buildManifest({ standaloneCommands: [{ name: 'git-commit', sourceFile: srcB }] }),
      sourceUrl: 'https://b.git',
      sourceSha: 'b1',
      claudeHome,
      lockfile,
      preferredSources: { 'git-commit': 'https://a.git' },
    });

    const destPath = join(claudeHome, 'commands/git-commit.md');
    expect(second.conflicts).toEqual([]);
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toEqual([]);
    expect(second.backups).toEqual([]);
    expect(await read(destPath)).toBe('from-A');
    expect(lockfile.installed[destPath]!.sourceUrl).toBe('https://a.git');
  });

  it('staging tree is removed on success and ~/.claude/ contains no .ccpp-staging-* dir', async () => {
    const helloSrc = await writeSourceFile('commands/hello.md', 'h');
    const skillMd = await writeSourceFile('plugins/p/skills/s1/SKILL.md', 's');
    const lockfile: Lockfile = emptyLockfile();
    await applyManifest({
      manifest: buildManifest({
        standaloneCommands: [{ name: 'hello', sourceFile: helloSrc }],
        plugins: [
          {
            name: 'p',
            version: '0.1.0',
            description: '',
            dir: join(sourceRoot, 'plugins/p'),
            commands: [],
            skills: [
              { name: 's1', sourceDir: join(sourceRoot, 'plugins/p/skills/s1'), files: [skillMd] },
            ],
            agents: [],
          },
        ],
      }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });

    const claudeEntries = await listDir(claudeHome);
    expect(claudeEntries.some((e) => e.startsWith('.ccpp-staging-'))).toBe(false);
    expect(claudeEntries.sort()).toEqual(['commands', 'skills']);
  });

  it('phase-1 failure leaves ~/.claude/ untouched and removes the staging tree', async () => {
    // Two source files: one valid, one a symlink that readFileSafe will refuse.
    // Order matters — the symlink comes second so the first file is staged
    // before the failure surfaces.
    const okSrc = await writeSourceFile('commands/ok.md', 'ok body');
    const linkPath = join(sourceRoot, 'commands', 'evil.md');
    await fs.symlink(join(scratch, 'leak'), linkPath);

    const lockfile: Lockfile = emptyLockfile();
    await expect(
      applyManifest({
        manifest: buildManifest({
          standaloneCommands: [
            { name: 'ok', sourceFile: okSrc },
            { name: 'evil', sourceFile: linkPath },
          ],
        }),
        sourceUrl: 'https://x/one.git',
        sourceSha: 'sha-1',
        claudeHome,
        lockfile,
      }),
    ).rejects.toThrow(/refusing to read symlink/i);

    // The first command was staged; phase-1 cleanup should have removed it.
    const claudeEntries = await listDir(claudeHome);
    expect(claudeEntries.some((e) => e.startsWith('.ccpp-staging-'))).toBe(false);
    // commands/ should not exist OR should be empty — applyManifest never
    // created it because the throw came before phase 2.
    const commandsDir = join(claudeHome, 'commands');
    const cmds = await fs.readdir(commandsDir).catch(() => []);
    expect(cmds).toEqual([]);

    // Lockfile is empty — no entries committed.
    expect(Object.keys(lockfile.installed)).toEqual([]);
  });
});

describe('removeFromLockfile', () => {
  it('moves each installed file to a .bak.<timestamp> and drops lockfile entries', async () => {
    const helloSrc = await writeSourceFile('commands/hello.md', 'hello');
    const skillMd = await writeSourceFile('plugins/p/skills/s/SKILL.md', 'skill');
    const lockfile: Lockfile = emptyLockfile();
    lockfile.sources['https://x/one.git'] = {
      sha: 'sha-1',
      ref: 'main',
      lastSync: '2026-04-22T00:00:00.000Z',
    };

    await applyManifest({
      manifest: buildManifest({
        standaloneCommands: [{ name: 'hello', sourceFile: helloSrc }],
        plugins: [
          {
            name: 'p',
            version: '0.1.0',
            description: 'p',
            dir: join(sourceRoot, 'plugins/p'),
            commands: [],
            skills: [
              {
                name: 's',
                sourceDir: join(sourceRoot, 'plugins/p/skills/s'),
                files: [skillMd],
              },
            ],
            agents: [],
          },
        ],
      }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });

    const result = await removeFromLockfile({
      name: 'https://x/one.git',
      claudeHome,
      lockfile,
    });

    expect(result.removed.sort()).toEqual(
      [join(claudeHome, 'commands/hello.md'), join(claudeHome, 'skills/s/SKILL.md')].sort(),
    );
    expect(result.backups).toHaveLength(2);
    for (const bak of result.backups) {
      expect(bak).toMatch(/\.bak\.\d{4}-\d{2}-\d{2}T/);
      expect(bak).not.toContain(':');
      await expect(fs.access(bak)).resolves.toBeUndefined();
    }
    const commandsRemaining = await listDir(join(claudeHome, 'commands'));
    expect(commandsRemaining.every((f) => f.includes('.bak.'))).toBe(true);
    await expect(fs.access(join(claudeHome, 'commands/hello.md'))).rejects.toThrow();
    expect(lockfile.installed).toEqual({});
    expect(lockfile.sources).toEqual({});
  });

  it('refuses to copy a source file that is a symlink (defense-in-depth beyond walkFiles)', async () => {
    // The manifest walker filters symlinks at readdir time via Dirent.isFile(),
    // so in practice the installer never sees one. This test bypasses the
    // walker and constructs a manifest whose sourceFile is a symlink to
    // verify the last-mile lstat guard catches it anyway.
    const realTarget = await writeSourceFile('real.md', 'attacker-controlled bytes');
    const linkPath = join(sourceRoot, 'commands', 'evil.md');
    await fs.mkdir(dirname(linkPath), { recursive: true });
    await fs.symlink(realTarget, linkPath);

    const lockfile: Lockfile = emptyLockfile();
    await expect(
      applyManifest({
        manifest: buildManifest({ standaloneCommands: [{ name: 'evil', sourceFile: linkPath }] }),
        sourceUrl: 'https://x/one.git',
        sourceSha: 'sha-1',
        claudeHome,
        lockfile,
      }),
    ).rejects.toThrow(/refusing to read symlink/i);

    // Nothing should have been written.
    await expect(fs.access(join(claudeHome, 'commands/evil.md'))).rejects.toThrow();
    expect(lockfile.installed).toEqual({});
  });

  it('silently skips files already gone from disk but still drops lockfile entries', async () => {
    const helloSrc = await writeSourceFile('commands/hello.md', 'hello');
    const lockfile: Lockfile = emptyLockfile();
    await applyManifest({
      manifest: buildManifest({ standaloneCommands: [{ name: 'hello', sourceFile: helloSrc }] }),
      sourceUrl: 'https://x/one.git',
      sourceSha: 'sha-1',
      claudeHome,
      lockfile,
    });
    await fs.rm(join(claudeHome, 'commands/hello.md'));

    const result = await removeFromLockfile({
      name: 'https://x/one.git',
      claudeHome,
      lockfile,
    });

    expect(result.removed).toEqual([join(claudeHome, 'commands/hello.md')]);
    expect(result.backups).toEqual([]);
    expect(lockfile.installed).toEqual({});
  });
});
