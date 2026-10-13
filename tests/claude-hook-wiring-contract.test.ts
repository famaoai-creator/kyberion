import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function readJson(relPath: string): unknown {
  return JSON.parse(safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string);
}

interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

function hookCommands(groups: HookGroup[] | undefined): string[] {
  return (groups ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));
}

/**
 * The kyberion hooks must fire whether the operator installed the
 * kyberion-claude-code plugin or not. The tracked `.claude/settings.json` is
 * the always-on wiring; the plugin's hooks.json is the installable copy.
 * Both must drive the same events into `dist/scripts/claude_code_hook.js`.
 */
describe('Claude Code hook wiring contract', () => {
  const settings = readJson('.claude/settings.json') as {
    hooks: Record<string, HookGroup[]>;
  };
  const plugin = readJson('plugins/kyberion-claude-code/hooks/hooks.json') as {
    hooks: Record<string, HookGroup[]>;
  };

  it('wires every plugin hook event in the tracked settings.json', () => {
    for (const event of Object.keys(plugin.hooks)) {
      expect(
        settings.hooks[event],
        `.claude/settings.json is missing the ${event} hook`
      ).toBeDefined();
    }
  });

  it('routes the same hook events to dist/scripts/claude_code_hook.js', () => {
    for (const [event, groups] of Object.entries(plugin.hooks)) {
      const pluginTargets = new Set(
        hookCommands(groups)
          .filter((command) => command.includes('claude_code_hook'))
          .map((command) => command.split(' ').pop())
      );
      const settingsTargets = new Set(
        hookCommands(settings.hooks[event])
          .filter((command) => command.includes('claude_code_hook.js'))
          .map((command) => command.split(' ').pop())
      );
      for (const target of pluginTargets) {
        expect(
          settingsTargets.has(target ?? ''),
          `.claude/settings.json ${event} does not invoke ${target}`
        ).toBe(true);
      }
    }
  });

  it('keeps PreToolUse matchers aligned with the plugin', () => {
    const settingsMatchers = (settings.hooks.PreToolUse ?? []).map((group) => group.matcher).sort();
    const pluginMatchers = (plugin.hooks.PreToolUse ?? []).map((group) => group.matcher).sort();
    expect(settingsMatchers).toEqual(pluginMatchers);
  });

  it('preserves the cloud bootstrap hook alongside the kyberion hooks', () => {
    const sessionStart = hookCommands(settings.hooks.SessionStart);
    expect(
      sessionStart.some((command) => command.includes('session-start.sh')),
      'cloud bootstrap session-start.sh must remain wired'
    ).toBe(true);
    expect(
      sessionStart.some((command) => command.includes('claude_code_hook.js')),
      'kyberion SessionStart hook must be wired'
    ).toBe(true);
  });
});
