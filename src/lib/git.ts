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

  // Classify the ref by asking the remote — `git ls-remote` is authoritative
  // and avoids the false positives of a hex-shape heuristic (a branch named
  // `abc1234` would otherwise misroute to the SHA path, which silently skips
  // the `reset --hard origin/<ref>` step on later syncs and never picks up
  // upstream branch tip moves). Distinguishing branch vs tag also matters
  // for the cache-widening step below: `set-branches` only makes sense for
  // branches (tags come along via `fetch --tags`).
  //
  // `git clone --depth 1 --branch <ref>` only works for branches and tags;
  // commit SHAs need a non-shallow clone and no --branch arg, then a plain
  // `git checkout <sha>` (no `origin/<sha>` reset since that ref doesn't
  // exist on the remote).
  const refKind: RefKind | undefined =
    opts.ref !== undefined ? await classifyRemoteRef(url, opts.ref) : undefined;
  const refIsSha = refKind === 'sha';

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
    // `git clone --branch <X>` (or a default shallow clone) sets a
    // single-branch refspec (`+refs/heads/X:refs/remotes/origin/X`); a plain
    // `git fetch` after that never sees any other branch, which breaks
    // `ccpp checkout <url> <other-branch>` on a cached repo. Widen the
    // refspec for the requested branch before fetching.
    //
    // Tags are exempt — `fetch --tags` covers them via the default tag
    // refspec; trying to set-branches a tag would add a bogus
    // `refs/heads/<tag>` entry that the next fetch would fail on with
    // "couldn't find remote ref refs/heads/<tag>".
    if (refKind === 'branch' && opts.ref !== undefined) {
      try {
        await runGit(['remote', 'set-branches', '--add', 'origin', opts.ref], { cwd: localPath });
      } catch {
        // set-branches failure is non-fatal: the subsequent fetch will use
        // whatever refspec is configured, and the checkout step below
        // surfaces a clearer error if the ref is truly missing.
      }
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

type RefKind = 'branch' | 'tag' | 'sha';

/**
 * Classify `ref` against the remote `url`: branch, tag, or commit SHA.
 *
 * Performs one `git ls-remote` querying both refs/heads/<ref> and
 * refs/tags/<ref>; the resulting stdout has one line per matching ref
 * (format `<sha>\t<full-ref>`) which we parse to distinguish branch from
 * tag. If neither matches, the ref is assumed to be a commit SHA (handled
 * downstream by a non-shallow clone path).
 *
 * Branches take precedence on the off chance someone names a branch and a
 * tag identically — the branch path matches git's own `checkout <name>`
 * disambiguation order.
 */
async function classifyRemoteRef(url: string, ref: string): Promise<RefKind> {
  // Any failure here (auth, DNS, repo-not-found) propagates — we want the
  // user to see a clear diagnostic instead of silently falling through to
  // the SHA clone path.
  const { stdout } = await runGit(
    ['ls-remote', '--quiet', url, `refs/heads/${ref}`, `refs/tags/${ref}`],
    { cwd: undefined },
  );

  const branchLine = `refs/heads/${ref}`;
  const tagLine = `refs/tags/${ref}`;
  for (const line of stdout.split('\n')) {
    if (line.endsWith(`\t${branchLine}`)) return 'branch';
  }
  for (const line of stdout.split('\n')) {
    if (line.endsWith(`\t${tagLine}`)) return 'tag';
  }
  return 'sha';
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
