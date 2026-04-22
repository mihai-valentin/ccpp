import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LocalGitFixture {
  /** file:// URL pointing at the bare repo (works as a git clone source). */
  url: string;
  /** Absolute path to the bare repo directory. */
  barePath: string;
  /** Absolute path to the scratch working repo used to push commits into the bare repo. */
  workPath: string;
  /** Commit a new file and push to the bare repo. Returns the new HEAD SHA. */
  advance: (filename: string, content: string) => Promise<string>;
  /** Delete every temp directory created by this fixture. */
  cleanup: () => Promise<void>;
}

export async function createLocalGitFixture(label = 'ccpp-git-fixture'): Promise<LocalGitFixture> {
  const root = await fs.mkdtemp(join(tmpdir(), `${label}-`));
  const barePath = join(root, 'origin.git');
  const workPath = join(root, 'work');

  await fs.mkdir(barePath, { recursive: true });
  await run(['init', '--bare', '--initial-branch=main', barePath], { cwd: undefined });

  await fs.mkdir(workPath, { recursive: true });
  await run(['init', '--initial-branch=main'], { cwd: workPath });
  await run(['config', 'user.email', 'fixture@example.com'], { cwd: workPath });
  await run(['config', 'user.name', 'Fixture'], { cwd: workPath });
  await run(['config', 'commit.gpgsign', 'false'], { cwd: workPath });
  await fs.writeFile(join(workPath, 'README.md'), '# fixture\n');
  await run(['add', 'README.md'], { cwd: workPath });
  await run(['commit', '-m', 'initial'], { cwd: workPath });
  await run(['remote', 'add', 'origin', barePath], { cwd: workPath });
  await run(['push', '-u', 'origin', 'main'], { cwd: workPath });
  // Make sure the bare repo's HEAD points at main so symbolic-ref works on clones.
  await run(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: barePath });

  const url = `file://${barePath}`;

  return {
    url,
    barePath,
    workPath,
    advance: async (filename: string, content: string) => {
      await fs.writeFile(join(workPath, filename), content);
      await run(['add', filename], { cwd: workPath });
      await run(['commit', '-m', `advance ${filename}`], { cwd: workPath });
      await run(['push', 'origin', 'main'], { cwd: workPath });
      const { stdout } = await run(['rev-parse', 'HEAD'], { cwd: workPath });
      return stdout.trim();
    },
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function run(
  args: string[],
  opts: { cwd: string | undefined },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
      }
    });
  });
}
