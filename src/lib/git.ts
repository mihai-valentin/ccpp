import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ParsedRepoUrl {
  host: string;
  owner: string;
  repo: string;
}

export interface CloneOrUpdateOptions {
  /** Branch, tag, or commit to check out. Defaults to the remote's default branch. */
  ref?: string;
  /** Root directory for the cache. Defaults to `$CCPP_CACHE` or `~/.ccpp/cache`. */
  cacheRoot?: string;
  /** Disable the default shallow `--depth 1` clone. */
  fullClone?: boolean;
}

export interface CloneOrUpdateResult {
  localPath: string;
  sha: string;
  ref: string;
}

export function parseRepoUrl(url: string): ParsedRepoUrl {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    throw new Error('Git URL is empty');
  }

  if (!trimmed.includes('://')) {
    const scp = /^([^@\s]+)@([^:\s]+):(.+)$/.exec(trimmed);
    if (scp) {
      const host = scp[2]!;
      const path = stripDotGit(scp[3]!);
      return { host, ...splitOwnerRepo(path, url) };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Unsupported git URL (cannot parse): ${url}`);
  }
  if (parsed.protocol === 'file:') {
    const filePath = stripDotGit(parsed.pathname.replace(/^\/+/, ''));
    return { host: 'file', ...splitOwnerRepo(filePath, url) };
  }
  const host = parsed.hostname;
  if (host.length === 0) {
    throw new Error(`Unsupported git URL (missing host): ${url}`);
  }
  const path = stripDotGit(parsed.pathname.replace(/^\/+/, ''));
  return { host, ...splitOwnerRepo(path, url) };
}

function stripDotGit(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -'.git'.length) : path;
}

function splitOwnerRepo(path: string, originalUrl: string): { owner: string; repo: string } {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0 || idx === trimmed.length - 1 || idx === 0) {
    throw new Error(`Unsupported git URL (expected owner/repo in path): ${originalUrl}`);
  }
  return { owner: trimmed.slice(0, idx), repo: trimmed.slice(idx + 1) };
}

export function defaultCacheRoot(): string {
  const override = process.env.CCPP_CACHE;
  if (override && override.length > 0) return override;
  return join(homedir(), '.ccpp', 'cache');
}

export function cachePathFor(url: string, cacheRoot: string = defaultCacheRoot()): string {
  const { host, owner, repo } = parseRepoUrl(url);
  return join(cacheRoot, host, owner, repo);
}

export async function cloneOrUpdate(
  url: string,
  opts: CloneOrUpdateOptions = {},
): Promise<CloneOrUpdateResult> {
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const localPath = cachePathFor(url, cacheRoot);

  const alreadyCloned = await pathExists(join(localPath, '.git'));
  if (!alreadyCloned) {
    await fs.mkdir(join(localPath, '..'), { recursive: true });
    const cloneArgs: string[] = ['clone'];
    if (!opts.fullClone) cloneArgs.push('--depth', '1');
    if (opts.ref !== undefined) cloneArgs.push('--branch', opts.ref);
    cloneArgs.push('--', url, localPath);
    await runGit(cloneArgs, { cwd: undefined });
  } else {
    await runGit(['fetch', '--tags', '--prune', 'origin'], { cwd: localPath });
  }

  const ref = opts.ref ?? (await resolveDefaultBranch(localPath));
  await runGit(['checkout', ref], { cwd: localPath });
  const resetTarget = (await hasRef(localPath, `origin/${ref}`)) ? `origin/${ref}` : ref;
  await runGit(['reset', '--hard', resetTarget], { cwd: localPath });

  const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: localPath })).stdout.trim();

  return { localPath, sha, ref };
}

export async function clearCache(url?: string, cacheRoot?: string): Promise<void> {
  const root = cacheRoot ?? defaultCacheRoot();
  const target = url === undefined ? root : cachePathFor(url, root);
  await fs.rm(target, { recursive: true, force: true });
}

async function resolveDefaultBranch(repoDir: string): Promise<string> {
  try {
    const out = await runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: repoDir,
    });
    const ref = out.stdout.trim();
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
  } catch {
    const out = await runGit(['remote', 'set-head', 'origin', '--auto'], { cwd: repoDir });
    const match = /\bset to (\S+)/.exec(out.stdout + out.stderr);
    if (match) return match[1]!;
    throw new Error(`Could not determine default branch for ${repoDir}`);
  }
}

async function hasRef(repoDir: string, ref: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', ref], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

interface RunGitOptions {
  cwd: string | undefined;
}

interface RunGitResult {
  stdout: string;
  stderr: string;
}

export function runGit(args: string[], opts: RunGitOptions): Promise<RunGitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
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
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const cmd = `git ${args.join(' ')}`;
        const tail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`${cmd} failed (exit ${code}): ${tail}`));
      }
    });
  });
}
