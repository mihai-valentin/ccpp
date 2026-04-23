import {
  AUTO_ACCEPT_WARNING,
  POLICY_LATEST_WARNING,
  type SyncPolicy,
} from '../lib/config.js';
import { parseRepoUrl } from '../lib/git.js';
import { bold, dim, yellow } from '../lib/term.js';

/**
 * IO surface used by the wizard. Injectable so tests can drive the state
 * machine with canned answers instead of poking stdin / readline.
 */
export interface WizardIO {
  /** Write a line to the user-facing output channel (stdout in prod). */
  out(line: string): void;
  /** Free-text prompt. Returns trimmed input (or `defaultValue` on empty). */
  promptLine(message: string, opts?: { defaultValue?: string }): Promise<string>;
  /** Numbered multiple-choice. Accepts the choice label or its 1-based index. */
  promptChoice<T extends string>(
    message: string,
    choices: readonly T[],
    defaultValue: T,
  ): Promise<T>;
  /** `[y/N]` style prompt. Empty / EOF → false. */
  promptYesNo(message: string): Promise<boolean>;
}

export interface WizardPlan {
  url: string;
  ref?: string;
  syncPolicy: SyncPolicy;
  autoAccept: boolean;
  installHook: boolean;
}

/**
 * Walk the user through a first-time install. Returns a collected plan on
 * confirm, or `null` if the user aborts at the final summary. Risk
 * acknowledgements (`syncPolicy: latest`, `autoAccept: true`) are surfaced
 * inline with the same warning text as `ccpp config set`; declining either
 * loops back to the relevant prompt so the user can pick a safer value
 * without restarting from scratch.
 */
export async function runInstallWizard(io: WizardIO): Promise<WizardPlan | null> {
  io.out(bold('ccpp — first-time setup'));
  io.out('This wizard will register a source, set the sync policy, and');
  io.out('optionally install the Claude Code SessionStart hook.');
  io.out('');

  const url = await askUrl(io);
  const ref = await askRef(io);
  const syncPolicy = await askSyncPolicy(io);
  const autoAccept = syncPolicy === 'latest' ? await askAutoAccept(io) : false;
  const installHook = await askInstallHook(io, syncPolicy, autoAccept);

  io.out('');
  io.out(bold('Plan'));
  io.out(`  source:      ${url}${ref !== undefined ? dim(` @ ${ref}`) : ''}`);
  io.out(`  syncPolicy:  ${syncPolicy}`);
  io.out(`  autoAccept:  ${autoAccept}${syncPolicy === 'pinned' ? dim(' (no effect while pinned — diff-preview stays on)') : ''}`);
  io.out(`  hook:        ${installHook ? 'install SessionStart hook' : 'skip'}`);
  io.out('');

  const confirm = await io.promptYesNo('Apply this plan? [Y/n]');
  if (!confirm) {
    io.out(`${yellow('!')} cancelled — nothing was written.`);
    return null;
  }
  const plan: WizardPlan = { url, syncPolicy, autoAccept, installHook };
  if (ref !== undefined) plan.ref = ref;
  return plan;
}

async function askUrl(io: WizardIO): Promise<string> {
  for (;;) {
    const raw = await io.promptLine('Source repo URL (git@host:owner/repo.git or https://…):');
    const url = raw.trim();
    if (url.length === 0) {
      io.out(`  ${yellow('!')} URL is required.`);
      continue;
    }
    try {
      parseRepoUrl(url);
      return url;
    } catch (err) {
      io.out(`  ${yellow('!')} ${(err as Error).message}`);
    }
  }
}

async function askRef(io: WizardIO): Promise<string | undefined> {
  const raw = await io.promptLine(
    'Ref (branch/tag/SHA) — leave blank for the repo default:',
    { defaultValue: '' },
  );
  const v = raw.trim();
  return v.length === 0 ? undefined : v;
}

async function askSyncPolicy(io: WizardIO): Promise<SyncPolicy> {
  for (;;) {
    const choice = await io.promptChoice<SyncPolicy>(
      'Sync policy — how should `ccpp sync` treat upstream changes?',
      ['pinned', 'latest'],
      'pinned',
    );
    if (choice === 'pinned') return 'pinned';
    io.out('');
    io.out(yellow(POLICY_LATEST_WARNING));
    const ok = await io.promptYesNo('');
    if (ok) return 'latest';
    io.out(`  ${dim('keeping safer default — pick again')}`);
  }
}

async function askAutoAccept(io: WizardIO): Promise<boolean> {
  for (;;) {
    const ok = await io.promptYesNo(
      'Enable autoAccept (skip the diff-preview prompt on every sync)? [y/N]',
    );
    if (!ok) return false;
    io.out('');
    io.out(yellow(AUTO_ACCEPT_WARNING));
    const confirmed = await io.promptYesNo('');
    if (confirmed) return true;
    io.out(`  ${dim('keeping safer default — diff-preview stays on')}`);
    return false;
  }
}

async function askInstallHook(
  io: WizardIO,
  syncPolicy: SyncPolicy,
  autoAccept: boolean,
): Promise<boolean> {
  const note =
    syncPolicy === 'latest' && autoAccept
      ? ''
      : dim(
          ' — note: hook runs `ccpp sync --auto-accept`, so it only fully auto-updates when policy=latest',
        );
  return io.promptYesNo(`Install SessionStart hook?${note} [y/N]`);
}
