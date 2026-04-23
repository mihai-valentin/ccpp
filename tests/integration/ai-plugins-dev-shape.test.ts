import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '..', '..');
const cliPath = join(projectRoot, 'dist', 'cli.cjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Neutralise the host machine's git configuration so tests don't pick up
// settings like core.autocrlf=true that would rewrite newline bytes.
const GIT_NEUTRAL_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', ...GIT_NEUTRAL_ENV, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

async function writeFile(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function listBackups(dir: string, baseName: string): Promise<string[]> {
  const entries = await fs.readdir(dir).catch(() => []);
  return entries.filter((n) => n.startsWith(`${baseName}.bak.`));
}

async function ensureBuilt(): Promise<void> {
  try {
    await fs.access(cliPath);
    return;
  } catch {
    // fall through to build
  }
  const r = await run('npm', ['run', 'build'], { cwd: projectRoot });
  if (r.code !== 0) throw new Error(`npm run build failed: ${r.stderr || r.stdout}`);
}

// Every CLI invocation MUST carry --claude-home so no sync accidentally writes
// to the real ~/.claude — prepend it if the caller forgot.
function cli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; claudeHome: string },
): Promise<RunResult> {
  const withHome = args.includes('--claude-home')
    ? args
    : [...args, '--claude-home', opts.claudeHome];
  return run('node', [cliPath, ...withHome], opts);
}

/* ---------- fixture content mirroring a real-world private skills repo ---------- */

const PR_WORKFLOW_PLUGIN_JSON = `${JSON.stringify(
  {
    name: 'ai-pr-workflow',
    version: '0.1.0',
    description: 'Commit-message and PR-description discipline for AI-augmented workflows.',
    author: { name: 'Example Org AI Tooling' },
    keywords: ['pr', 'commit', 'git', 'ai', 'workflow'],
  },
  null,
  2,
)}\n`;

const GIT_CONFLICT_PLUGIN_JSON = `${JSON.stringify(
  {
    name: 'git-conflict-resolver',
    version: '0.1.0',
    description:
      'Resolve git merge conflicts thoughtfully using three-way context.',
    author: { name: 'Example Org AI Tooling' },
    keywords: ['git', 'merge', 'conflict'],
  },
  null,
  2,
)}\n`;

const AI_PLUGINS_DEV_SHAPE: Record<string, string> = {
  'commands/fix-session.md': '# fix-session\n',
  'commands/review-changes.md': '# review-changes\n',
  'plugins/ai-pr-workflow/.claude-plugin/plugin.json': PR_WORKFLOW_PLUGIN_JSON,
  'plugins/ai-pr-workflow/commands/git-commit.md': '# git-commit\n',
  'plugins/ai-pr-workflow/commands/pr-summary.md': '# pr-summary\n',
  'plugins/ai-pr-workflow/skills/git-commit/SKILL.md': '# git-commit skill\n',
  'plugins/ai-pr-workflow/skills/pr-summary/SKILL.md': '# pr-summary skill\n',
  'plugins/git-conflict-resolver/.claude-plugin/plugin.json': GIT_CONFLICT_PLUGIN_JSON,
  'plugins/git-conflict-resolver/commands/git-resolve-conflicts.md':
    '# git-resolve-conflicts\n',
  'plugins/git-conflict-resolver/skills/resolve-conflicts/SKILL.md':
    '# resolve-conflicts skill\n',
  'plugins/git-conflict-resolver/skills/resolve-conflicts/references/merge-semantics.md':
    '# merge semantics\n',
};

interface Fixture {
  bareUrl: string;
  barePath: string;
  workPath: string;
  initialSha: string;
}

async function createFixture(
  label: string,
  root: string,
  files: Record<string, string>,
): Promise<Fixture> {
  const barePath = join(root, `${label}.git`);
  const workPath = join(root, `${label}-work`);
  await fs.mkdir(barePath, { recursive: true });
  await fs.mkdir(workPath, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', barePath], root);
  await git(['init', '--initial-branch=main'], workPath);
  await git(['config', 'user.email', 'fixture@example.com'], workPath);
  await git(['config', 'user.name', 'Fixture'], workPath);
  await git(['config', 'commit.gpgsign', 'false'], workPath);
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(workPath, rel), content);
  }
  await git(['add', '-A'], workPath);
  await git(['commit', '-m', 'initial'], workPath);
  await git(['remote', 'add', 'origin', barePath], workPath);
  await git(['push', '-u', 'origin', 'main'], workPath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], barePath);
  const { stdout } = await git(['rev-parse', 'HEAD'], workPath);
  return { bareUrl: `file://${barePath}`, barePath, workPath, initialSha: stdout.trim() };
}

async function pushUpdate(
  workPath: string,
  rel: string,
  content: string,
  msg = 'update',
): Promise<string> {
  await writeFile(join(workPath, rel), content);
  await git(['add', rel], workPath);
  await git(['commit', '-m', msg], workPath);
  await git(['push', 'origin', 'main'], workPath);
  const { stdout } = await git(['rev-parse', 'HEAD'], workPath);
  return stdout.trim();
}

/* ---------- tests ---------- */

describe('ai-plugins-dev shape — end-to-end', () => {
  let tmp: string;
  let claudeHome: string;
  let cacheRoot: string;
  let cwd: string;
  let configPath: string;
  let lockfilePath: string;
  let primary: Fixture;
  let collision: Fixture;
  let env: Record<string, string>;

  beforeAll(async () => {
    await ensureBuilt();
    tmp = await fs.mkdtemp(join(tmpdir(), 'ccpp-int-'));
    claudeHome = join(tmp, 'claude');
    cacheRoot = join(tmp, 'cache');
    cwd = join(tmp, 'project');
    configPath = join(cwd, 'ccpp.config.json');
    lockfilePath = join(cwd, 'ccpp.lock.json');
    await fs.mkdir(cwd, { recursive: true });
    env = { CCPP_CACHE: cacheRoot };

    primary = await createFixture('ai-plugins-dev', tmp, AI_PLUGINS_DEV_SHAPE);
    collision = await createFixture('overlap', tmp, {
      'commands/git-commit.md': '# collision git-commit\n',
    });
  }, 60_000);

  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('1 — fresh install materialises every command + skill and writes the lockfile', async () => {
    const r = await cli(['install', primary.bareUrl], { cwd, env, claudeHome });
    expect(r.code).toBe(0);

    const expectedCommands = [
      'fix-session',
      'review-changes',
      'git-commit',
      'pr-summary',
      'git-resolve-conflicts',
    ];
    for (const name of expectedCommands) {
      const p = join(claudeHome, 'commands', `${name}.md`);
      expect(await pathExists(p), `command missing: ${p}`).toBe(true);
    }

    const expectedSkillFiles: Array<[string, string]> = [
      ['git-commit', 'SKILL.md'],
      ['pr-summary', 'SKILL.md'],
      ['resolve-conflicts', 'SKILL.md'],
      ['resolve-conflicts', 'references/merge-semantics.md'],
    ];
    for (const [skill, rel] of expectedSkillFiles) {
      const p = join(claudeHome, 'skills', skill, rel);
      expect(await pathExists(p), `skill file missing: ${p}`).toBe(true);
    }
    expect(
      await fs.readFile(
        join(claudeHome, 'skills', 'resolve-conflicts', 'references', 'merge-semantics.md'),
        'utf8',
      ),
    ).toBe('# merge semantics\n');

    const lock = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
    expect(lock.sources[primary.bareUrl].sha).toBe(primary.initialSha);
    const installedKeys = Object.keys(lock.installed);
    for (const name of expectedCommands) {
      expect(installedKeys.some((p) => p.endsWith(`commands/${name}.md`))).toBe(true);
    }
    for (const [skill, rel] of expectedSkillFiles) {
      expect(installedKeys.some((p) => p.endsWith(`skills/${skill}/${rel}`))).toBe(true);
    }

    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          sources: [{ url: primary.bareUrl }],
          scope: 'user',
          autoAccept: true,
          autoAcceptAcknowledgedAt: '2026-04-23T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );
  }, 30_000);

  it('2 — idempotent re-sync leaves file mtimes untouched', async () => {
    const sample = join(claudeHome, 'commands', 'fix-session.md');
    const before = await fs.stat(sample);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 20));

    const r = await cli(['sync'], { cwd, env, claudeHome });
    expect(r.code).toBe(0);

    const after = await fs.stat(sample);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }, 30_000);

  it('3 — source update rewrites only the changed file and leaves a timestamped backup', async () => {
    const fixSession = join(claudeHome, 'commands', 'fix-session.md');
    const untouched = join(claudeHome, 'commands', 'review-changes.md');
    const untouchedBefore = await fs.stat(untouched);

    const newSha = await pushUpdate(
      primary.workPath,
      'commands/fix-session.md',
      '# fix-session v2\n',
      'bump fix-session',
    );

    const r = await cli(['sync'], { cwd, env, claudeHome });
    expect(r.code).toBe(0);

    expect(await fs.readFile(fixSession, 'utf8')).toBe('# fix-session v2\n');

    const backups = await listBackups(dirname(fixSession), 'fix-session.md');
    expect(backups.length).toBeGreaterThan(0);
    const backupContent = await fs.readFile(
      join(dirname(fixSession), backups[0]!),
      'utf8',
    );
    expect(backupContent).toBe('# fix-session\n');

    const lock = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
    expect(lock.sources[primary.bareUrl].sha).toBe(newSha);

    const untouchedAfter = await fs.stat(untouched);
    expect(untouchedAfter.mtimeMs).toBe(untouchedBefore.mtimeMs);
  }, 30_000);

  it('4 — collision from a second source exits 3 and never overwrites the existing file', async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          sources: [{ url: primary.bareUrl }, { url: collision.bareUrl }],
          scope: 'user',
          autoAccept: true,
          autoAcceptAcknowledgedAt: '2026-04-23T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );

    const gitCommit = join(claudeHome, 'commands', 'git-commit.md');
    const beforeBytes = await fs.readFile(gitCommit, 'utf8');

    const r = await cli(['sync'], { cwd, env, claudeHome });
    expect(r.code).toBe(3);
    expect(r.stderr.toLowerCase()).toMatch(/collision/);
    expect(r.stderr.toLowerCase()).toMatch(/prefer/);

    expect(await fs.readFile(gitCommit, 'utf8')).toBe(beforeBytes);
  }, 30_000);

  it('5 — preferredSources resolves the collision, leaving the winning file untouched', async () => {
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          sources: [{ url: primary.bareUrl }, { url: collision.bareUrl }],
          scope: 'user',
          autoAccept: true,
          autoAcceptAcknowledgedAt: '2026-04-23T00:00:00.000Z',
          preferredSources: { 'git-commit': primary.bareUrl },
        },
        null,
        2,
      )}\n`,
    );

    const gitCommit = join(claudeHome, 'commands', 'git-commit.md');
    const before = await fs.stat(gitCommit);
    const beforeBytes = await fs.readFile(gitCommit, 'utf8');
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 20));

    const r = await cli(['sync'], { cwd, env, claudeHome });
    expect(r.code).toBe(0);

    expect(await fs.readFile(gitCommit, 'utf8')).toBe(beforeBytes);
    const after = await fs.stat(gitCommit);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }, 30_000);

  it('6 — uninstalling the owning source removes its files with backups and drops lockfile entries', async () => {
    const gitCommit = join(claudeHome, 'commands', 'git-commit.md');
    expect(await pathExists(gitCommit)).toBe(true);

    const r = await cli(['uninstall', primary.bareUrl], { cwd, env, claudeHome });
    expect(r.code).toBe(0);

    expect(await pathExists(gitCommit)).toBe(false);
    const backups = await listBackups(dirname(gitCommit), 'git-commit.md');
    expect(backups.length).toBeGreaterThan(0);

    const lock = JSON.parse(await fs.readFile(lockfilePath, 'utf8'));
    const stillHasGitCommit = Object.entries(
      lock.installed as Record<string, { sourceUrl: string }>,
    ).some(
      ([p, entry]) =>
        p.endsWith('commands/git-commit.md') && entry.sourceUrl === primary.bareUrl,
    );
    expect(stillHasGitCommit).toBe(false);
  }, 30_000);
});
