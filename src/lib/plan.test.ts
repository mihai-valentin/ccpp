import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planFiles } from './plan.js';
import type { ResolvedManifest } from './types.js';

const SOURCE_ROOT = '/source';
const CLAUDE_HOME = '/claude';

function manifest(overrides: Partial<ResolvedManifest> = {}): ResolvedManifest {
  return {
    sourceDir: SOURCE_ROOT,
    standaloneCommands: [],
    standaloneSkills: [],
    standaloneAgents: [],
    plugins: [],
    ...overrides,
  };
}

describe('planFiles', () => {
  it('produces zero items for an empty manifest', () => {
    expect(planFiles(manifest(), CLAUDE_HOME)).toEqual([]);
  });

  it('routes standalone commands to <claudeHome>/commands/<name>.md', () => {
    const out = planFiles(
      manifest({
        standaloneCommands: [
          { name: 'hello', sourceFile: join(SOURCE_ROOT, 'commands/hello.md') },
        ],
      }),
      CLAUDE_HOME,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      name: 'hello',
      sourceAbsolute: join(SOURCE_ROOT, 'commands/hello.md'),
      sourceRelative: join('commands', 'hello.md'),
      destPath: join(CLAUDE_HOME, 'commands', 'hello.md'),
    });
  });

  it('routes standalone skills to <claudeHome>/skills/<name>/<rel>', () => {
    const skillDir = join(SOURCE_ROOT, 'skills/handy');
    const out = planFiles(
      manifest({
        standaloneSkills: [
          {
            name: 'handy',
            sourceDir: skillDir,
            files: [join(skillDir, 'SKILL.md'), join(skillDir, 'refs/extra.md')],
          },
        ],
      }),
      CLAUDE_HOME,
    );
    expect(out.map((p) => p.destPath).sort()).toEqual([
      join(CLAUDE_HOME, 'skills/handy/SKILL.md'),
      join(CLAUDE_HOME, 'skills/handy/refs/extra.md'),
    ]);
    expect(out[0]!.sourceRelative).toMatch(/^skills[\\/]handy[\\/]/);
  });

  it('routes standalone agents to <claudeHome>/agents/<name>.md', () => {
    const out = planFiles(
      manifest({
        standaloneAgents: [
          { name: 'triage', sourceFile: join(SOURCE_ROOT, 'agents/triage.md') },
        ],
      }),
      CLAUDE_HOME,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.destPath).toBe(join(CLAUDE_HOME, 'agents', 'triage.md'));
  });

  it('routes plugin commands, skills, and agents under the same flat dirs', () => {
    const pluginDir = join(SOURCE_ROOT, 'plugins/p1');
    const skillDir = join(pluginDir, 'skills/s1');
    const out = planFiles(
      manifest({
        plugins: [
          {
            name: 'p1',
            version: '0.1.0',
            description: '',
            dir: pluginDir,
            commands: [{ name: 'c1', sourceFile: join(pluginDir, 'commands/c1.md') }],
            skills: [
              {
                name: 's1',
                sourceDir: skillDir,
                files: [join(skillDir, 'SKILL.md')],
              },
            ],
            agents: [{ name: 'a1', sourceFile: join(pluginDir, 'agents/a1.md') }],
          },
        ],
      }),
      CLAUDE_HOME,
    );
    const dests = out.map((p) => p.destPath).sort();
    expect(dests).toEqual([
      join(CLAUDE_HOME, 'agents', 'a1.md'),
      join(CLAUDE_HOME, 'commands', 'c1.md'),
      join(CLAUDE_HOME, 'skills', 's1', 'SKILL.md'),
    ]);
  });

  it('dedups when a standalone agent and a plugin agent target the same dest — first writer wins', () => {
    // Plan order: standalones first, plugins second. So a standalone agent
    // wins over a plugin agent of the same name within a single source.
    const standalone = join(SOURCE_ROOT, 'agents/triage.md');
    const plugin = join(SOURCE_ROOT, 'plugins/p1/agents/triage.md');
    const out = planFiles(
      manifest({
        standaloneAgents: [{ name: 'triage', sourceFile: standalone }],
        plugins: [
          {
            name: 'p1',
            version: '0.1.0',
            description: '',
            dir: join(SOURCE_ROOT, 'plugins/p1'),
            commands: [],
            skills: [],
            agents: [{ name: 'triage', sourceFile: plugin }],
          },
        ],
      }),
      CLAUDE_HOME,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceAbsolute).toBe(standalone);
  });
});
