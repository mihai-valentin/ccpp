import { describe, expect, it } from 'vitest';
import {
  runInstallWizard,
  summarizeInstalledTargets,
  type WizardIO,
  type WizardPlan,
} from './install-wizard.js';

/**
 * Programmable IO: feeds canned answers to the wizard and records every
 * prompt/output so tests can assert on the exact question order + replies.
 */
interface RecordedIO extends WizardIO {
  outputs: string[];
  asked: string[];
}

interface Scripted {
  lines?: string[];
  choices?: Record<string, string>; // message-prefix → answer
  yesNo?: Array<boolean | { match: RegExp; answer: boolean }>;
}

function makeIO(scripted: Scripted): RecordedIO {
  const lines = [...(scripted.lines ?? [])];
  const yesNoQueue = [...(scripted.yesNo ?? [])];
  const outputs: string[] = [];
  const asked: string[] = [];

  return {
    outputs,
    asked,
    out: (line: string) => {
      outputs.push(line);
    },
    promptLine: async (message: string, opts?: { defaultValue?: string }) => {
      asked.push(`line: ${message}`);
      if (lines.length === 0) {
        return opts?.defaultValue ?? '';
      }
      const next = lines.shift() as string;
      return next.length === 0 ? opts?.defaultValue ?? '' : next;
    },
    promptChoice: async (message, choices, def) => {
      asked.push(`choice: ${message}`);
      if (scripted.choices) {
        for (const [prefix, answer] of Object.entries(scripted.choices)) {
          if (message.startsWith(prefix)) {
            const found = choices.find((c) => c === answer);
            if (!found) throw new Error(`test bug: ${answer} not in ${choices.join(',')}`);
            return found;
          }
        }
      }
      return def;
    },
    promptYesNo: async (message: string) => {
      asked.push(`yesno: ${message}`);
      const next = yesNoQueue.shift();
      if (next === undefined) return false;
      if (typeof next === 'boolean') return next;
      if (next.match.test(message)) return next.answer;
      // Return false (safe default) on mismatch; aids debugging test fixtures.
      return false;
    },
  };
}

describe('runInstallWizard', () => {
  it('happy path — pinned, autoAccept skipped, no hook', async () => {
    const io = makeIO({
      lines: ['git@bitbucket.org:example-org/ai-plugins.git', ''], // url, ref-blank
      choices: { 'Sync policy': 'pinned' },
      yesNo: [
        { match: /SessionStart/, answer: false }, // hook? no
        { match: /Apply this plan/, answer: true }, // confirm plan
      ],
    });

    const plan = await runInstallWizard(io);
    expect(plan).not.toBeNull();
    expect(plan).toMatchObject<Partial<WizardPlan>>({
      url: 'git@bitbucket.org:example-org/ai-plugins.git',
      syncPolicy: 'pinned',
      autoAccept: false,
      installHook: false,
    });
    expect(plan!.ref).toBeUndefined();

    // autoAccept prompt must be skipped when policy=pinned.
    const asked = io.asked.join('\n');
    expect(asked).not.toMatch(/autoAccept/i);
  });

  it('ref flows through when user provides one', async () => {
    const io = makeIO({
      lines: ['https://github.com/org/repo.git', 'release-2026-04'],
      choices: { 'Sync policy': 'pinned' },
      yesNo: [false, true], // hook no, confirm yes
    });
    const plan = await runInstallWizard(io);
    expect(plan?.ref).toBe('release-2026-04');
  });

  it('latest policy triggers a second confirmation prompt with the exact warning text', async () => {
    const io = makeIO({
      lines: ['git@bitbucket.org:example-org/x.git', ''],
      choices: { 'Sync policy': 'latest' },
      yesNo: [
        true, // confirm latest-risk warning
        false, // autoAccept prompt → no
        false, // hook → no
        true, // confirm plan
      ],
    });
    const plan = await runInstallWizard(io);
    expect(plan?.syncPolicy).toBe('latest');
    expect(plan?.autoAccept).toBe(false);
    // The warning constant content must reach the user (via io.out, not prompt message).
    const combined = io.outputs.join('\n');
    expect(combined).toMatch(/Switching to syncPolicy:latest/);
  });

  it('autoAccept prompt fires only when syncPolicy=latest, and enabling requires a second confirm', async () => {
    const io = makeIO({
      lines: ['git@bitbucket.org:example-org/x.git', ''],
      choices: { 'Sync policy': 'latest' },
      yesNo: [
        true, // confirm latest risk
        true, // autoAccept? yes
        true, // autoAccept 2nd-confirm → proceed
        false, // hook no
        true, // confirm plan
      ],
    });
    const plan = await runInstallWizard(io);
    expect(plan?.autoAccept).toBe(true);
    const outputs = io.outputs.join('\n');
    expect(outputs).toMatch(/Enabling autoAccept/); // warning text shown
  });

  it('final "Apply this plan? [Y/n]" returning false yields null (no writes)', async () => {
    const io = makeIO({
      lines: ['git@bitbucket.org:example-org/x.git', ''],
      choices: { 'Sync policy': 'pinned' },
      yesNo: [false, false], // hook no, confirm NO
    });
    const plan = await runInstallWizard(io);
    expect(plan).toBeNull();
    expect(io.outputs.join('\n')).toMatch(/cancelled/i);
  });

  it('rejects an invalid URL and re-prompts', async () => {
    const io = makeIO({
      lines: [
        'not a url', // rejected
        '', // empty → rejected
        'git@github.com:ok/repo.git', // accepted
        '',
      ],
      choices: { 'Sync policy': 'pinned' },
      yesNo: [false, true],
    });
    const plan = await runInstallWizard(io);
    expect(plan?.url).toBe('git@github.com:ok/repo.git');
    // Two error messages were shown inline before the accepted URL.
    const errs = io.outputs.filter((l) => l.includes('Unsupported') || l.includes('required'));
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it('plan preview shows every collected field before the final confirm', async () => {
    const io = makeIO({
      lines: ['git@bitbucket.org:example-org/x.git', 'main'],
      choices: { 'Sync policy': 'pinned' },
      yesNo: [false, true],
    });
    await runInstallWizard(io);
    const outputs = io.outputs.join('\n');
    expect(outputs).toMatch(/source:\s+git@bitbucket\.org:example-org\/x\.git/);
    expect(outputs).toMatch(/syncPolicy:\s+pinned/);
    expect(outputs).toMatch(/autoAccept:\s+false/);
    expect(outputs).toMatch(/hook:\s+skip/);
  });
});

describe('summarizeInstalledTargets', () => {
  const home = '/home/u/.claude';

  it('counts newly installed files (classic first-install case)', () => {
    const { commandCount, skillNames } = summarizeInstalledTargets(
      {
        installed: [
          `${home}/commands/a.md`,
          `${home}/commands/b.md`,
          `${home}/skills/pr-review/SKILL.md`,
          `${home}/skills/pr-review/references/style.md`,
          `${home}/skills/git-commit/SKILL.md`,
        ],
        updated: [],
        unchanged: [],
      },
      home,
    );
    expect(commandCount).toBe(2);
    expect(skillNames).toEqual(['git-commit', 'pr-review']);
  });

  it('REGRESSION — counts unchanged + updated files too, not just newly-installed', () => {
    // Repro for the v0.1.3 wizard bug: re-running the wizard over an
    // already-populated ~/.claude/ classified every file as `unchanged`,
    // so the report showed "0 command(s), 0 skill(s) written" even
    // though `ccpp list` showed the full set.
    const { commandCount, skillNames } = summarizeInstalledTargets(
      {
        installed: [],
        updated: [`${home}/commands/changed.md`],
        unchanged: [
          `${home}/commands/stable-1.md`,
          `${home}/commands/stable-2.md`,
          `${home}/skills/review/SKILL.md`,
          `${home}/skills/review/refs/notes.md`,
        ],
      },
      home,
    );
    expect(commandCount).toBe(3);
    expect(skillNames).toEqual(['review']);
  });

  it('deduplicates multi-file skills into a single name', () => {
    const { skillNames } = summarizeInstalledTargets(
      {
        installed: [
          `${home}/skills/big/SKILL.md`,
          `${home}/skills/big/a.md`,
          `${home}/skills/big/b.md`,
          `${home}/skills/big/sub/c.md`,
        ],
        updated: [],
        unchanged: [],
      },
      home,
    );
    expect(skillNames).toEqual(['big']);
  });

  it('ignores files outside the claudeHome prefix', () => {
    const { commandCount, skillNames } = summarizeInstalledTargets(
      {
        installed: [`/somewhere/else/commands/nope.md`, `${home}/commands/yep.md`],
        updated: [],
        unchanged: [],
      },
      home,
    );
    expect(commandCount).toBe(1);
    expect(skillNames).toEqual([]);
  });
});
