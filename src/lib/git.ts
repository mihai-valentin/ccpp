import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathExists } from './fsutil.js';

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
    // SCP-style git URL: `<user>@<host>:<path>`, e.g. `git@github.com:org/repo.git`.
    // Captured groups: 1=user (unused), 2=host, 3=path. The colon is the
    // separator — a real URL would use `://` after the scheme.
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

  // Decide whether `opts.ref` is a named ref (branch or tag) or a commit SHA
  // by asking the remote — `git ls-remote` is authoritative and avoids the
  // false positives of a hex-shape heuristic (a branch literally named
  // `abc1234` would otherwise misroute to the SHA path, which silently
  // skips the `reset --hard origin/<ref>` step on later syncs and never
  // picks up upstream branch tip moves).
  //
  // `git clone --depth 1 --branch <ref>` only works for branches and tags;
  // commit SHAs need a non-shallow clone and no --branch arg, then a plain
  // `git checkout <sha>` (no `origin/<sha>` reset since that ref doesn't
  // exist on the remote).
  const refIsSha = opts.ref !== undefined && !(await isNamedRefRemote(url, opts.ref));

  const alreadyCloned = await pathExists(join(localPath, '.git'));
  if (!alreadyCloned) {
    await fs.mkdir(join(localPath, '..'), { recursive: true });
    const cloneArgs: string[] = ['clone'];
    if (!opts.fullClone && !refIsSha) cloneArgs.push('--depth', '1');
    if (opts.ref !== undefined && !refIsSha) cloneArgs.push('--branch', opts.ref);
    cloneArgs.push('--', url, localPath);
    await runGit(cloneArgs, { cwd: undefined });
  } else {
    if (refIsSha && (await isShallowRepo(localPath))) {
      // Need full history to resolve an arbitrary SHA.
      await runGit(['fetch', '--unshallow', 'origin'], { cwd: localPath });
    }
    await runGit(['fetch', '--tags', '--prune', 'origin'], { cwd: localPath });
  }

  const ref = opts.ref ?? (await resolveDefaultBranch(localPath));
  await runGit(['checkout', ref], { cwd: localPath });
  if (!refIsSha) {
    const resetTarget = (await hasRef(localPath, `origin/${ref}`)) ? `origin/${ref}` : ref;
    await runGit(['reset', '--hard', resetTarget], { cwd: localPath });
  }

  const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: localPath })).stdout.trim();

  return { localPath, sha, ref };
}

/**
 * True when `ref` exists as a branch or tag on the remote `url`.
 *
 * Uses `git ls-remote --exit-code` which exits 0 if at least one matching
 * ref is returned, 2 if none match, and any other non-zero on auth/network
 * failure. We resolve `false` only for the "no match" case (exit 2); other
 * errors propagate to surface a meaningful message. This replaces a hex-
 * shape heuristic that misclassified branches literally named like SHAs.
 */
async function isNamedRefRemote(url: string, ref: string): Promise<boolean> {
  try {
    await runGit(
      ['ls-remote', '--exit-code', '--quiet', url, `refs/heads/${ref}`, `refs/tags/${ref}`],
      { cwd: undefined },
    );
    return true;
  } catch (err) {
    // runGit's error message format is `${cmd} failed (exit ${code}): ${tail}`.
    // We only swallow the "no matching refs" case; any other failure (auth,
    // DNS, repo-not-found) re-throws so the user sees a real diagnostic
    // instead of a wrong-path SHA clone attempt.
    if (/failed \(exit 2\)/.test((err as Error).message)) return false;
    throw err;
  }
}

async function isShallowRepo(repoDir: string): Promise<boolean> {
  const out = await runGit(['rev-parse', '--is-shallow-repository'], { cwd: repoDir });
  return out.stdout.trim() === 'true';
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
        // Pin output language so regex parsers (e.g. resolveDefaultBranch's
        // `set to <branch>` matcher) work regardless of the user's LANG/LC_ALL.
        LC_ALL: 'C',
        LANG: 'C',
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
      reject(new Error(`Failed to spawn git: ${err.message}`, { cause: err }));
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
