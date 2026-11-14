import { describe, expect, it } from 'vitest';
import {
  buildClaudeSettings,
  buildCodexHooks,
  buildGeminiSettings,
} from './generate_provider_hook_configs.js';

describe('buildClaudeSettings', () => {
  it('migrates managed commands while preserving user settings, groups and permissions', () => {
    const custom = { type: 'command', command: 'custom-tool', timeout: 42 };
    const cloud = {
      type: 'command',
      command: '$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh',
    };
    const existing = {
      permissions: { allow: ['Bash(pnpm vitest run *)'] },
      theme: 'dark',
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              cloud,
              custom,
              {
                type: 'command',
                command: 'node "$CLAUDE_PROJECT_DIR/dist/scripts/claude_code_hook.js" SessionStart',
                timeout: 10,
              },
            ],
          },
        ],
        UnknownEvent: [{ hooks: [custom] }],
      },
    };
    const result = buildClaudeSettings(existing) as typeof existing;
    expect(result.permissions).toEqual(existing.permissions);
    expect(result.theme).toBe('dark');
    expect(result.hooks.UnknownEvent).toEqual(existing.hooks.UnknownEvent);
    expect(result.hooks.SessionStart[0]!.matcher).toBe('*');
    expect(result.hooks.SessionStart[0]!.hooks.slice(0, 2)).toEqual([cloud, custom]);
    expect(result.hooks.SessionStart[0]!.hooks[2]).toEqual({
      type: 'command',
      command: 'node "$CLAUDE_PROJECT_DIR/scripts/provider_hook_entry.mjs" claude SessionStart',
      timeout: 10,
    });
    expect(buildClaudeSettings(result)).toEqual(result);
    expect(existing.hooks.SessionStart[0]!.hooks[2]!.command).toContain('dist/scripts/');
  });

  it('preserves unknown shapes and non-managed commands', () => {
    const existing = {
      hooks: {
        Custom: 'custom',
        PreToolUse: [
          {
            hooks: [
              { command: 'echo dist/scripts/claude_code_hook.js PreToolUse' },
              { command: 'node user-hook.js PreToolUse' },
            ],
          },
        ],
      },
    };
    expect(buildClaudeSettings(existing)).toEqual(existing);
    expect(buildClaudeSettings({ permissions: { deny: ['x'] } })).toEqual({
      permissions: { deny: ['x'] },
    });
  });
});

describe('buildCodexHooks', () => {
  it('refuses to overwrite malformed user hook configuration', () => {
    expect(() => buildCodexHooks({ hooks: 'broken' })).toThrow('refusing to replace');
    expect(() => buildCodexHooks({ hooks: { UserPromptSubmit: {} } })).toThrow(
      'refusing to replace'
    );
  });
  it('preserves user hooks and stays idempotent across repeated generation', () => {
    const custom = { hooks: [{ type: 'command', command: 'custom-tool' }] };
    const existing = {
      description: 'my hooks',
      hooks: { UserPromptSubmit: [custom], Stop: [custom] },
    };
    const first = buildCodexHooks(existing);
    expect(buildCodexHooks(first)).toEqual(first);
    const hooks = first.hooks as Record<string, unknown[]>;
    expect(hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.UserPromptSubmit![0]).toEqual(custom);
    expect(hooks.Stop).toEqual([custom]);
    expect(first.description).toBe('my hooks');
    expect((buildCodexHooks().hooks as Record<string, unknown>).Stop).toBeUndefined();
  });

  it('uses Codex timeouts in seconds and preserves mixed command groups', () => {
    const generated = buildCodexHooks().hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string; timeout: number }> }>
    >;
    const own = generated.UserPromptSubmit![0]!.hooks[0]!;
    expect(own.command).toContain('provider_hook_entry.mjs');
    expect(own.command).toContain('codex UserPromptSubmit');
    const mixed = buildCodexHooks({
      hooks: {
        UserPromptSubmit: [
          { matcher: '*', hooks: [own, { type: 'command', command: 'custom-tool' }] },
        ],
      },
    });
    expect((mixed.hooks as typeof generated).UserPromptSubmit![0]!.hooks).toEqual([
      { type: 'command', command: 'custom-tool' },
    ]);
    expect(generated.SessionEnd![0]!.hooks[0]!.timeout).toBe(3);
    expect(generated.PostToolUse![0]!.hooks[0]!.timeout).toBe(10);
  });

  it('migrates direct dist commands without keeping duplicate managed hooks', () => {
    const hooks = buildCodexHooks({
      hooks: {
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: "node '/old/dist/scripts/codex_cli_hook.js' PostToolUse",
              },
              { type: 'command', command: 'custom-tool' },
            ],
          },
        ],
      },
    }).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.PostToolUse).toHaveLength(2);
    expect(hooks.PostToolUse![0]!.hooks[0]!.command).toBe('custom-tool');
    expect(hooks.PostToolUse![1]!.hooks[0]!.command).toContain('provider_hook_entry.mjs');
  });
});

describe('buildGeminiSettings', () => {
  it('renders the four owned hook event groups', () => {
    const settings = buildGeminiSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    for (const event of ['SessionStart', 'BeforeAgent', 'BeforeTool', 'SessionEnd']) {
      expect(hooks[event]).toHaveLength(1);
      const group = hooks[event]![0] as { hooks: Array<{ command: string }> };
      expect(group.hooks[0]!.command).toContain('provider_hook_entry.mjs');
      expect(group.hooks[0]!.command).toContain(`gemini ${event}`);
      expect(group.hooks[0]!.command).toContain(event);
    }
  });

  it('scopes BeforeTool to write tools only', () => {
    const settings = buildGeminiSettings();
    const hooks = settings.hooks as Record<string, Array<{ matcher?: string }>>;
    expect(hooks.BeforeTool![0]!.matcher).toBe('write_file|replace');
    expect(hooks.SessionStart![0]!.matcher).toBeUndefined();
  });

  it('preserves unrelated top-level keys and hook events', () => {
    const settings = buildGeminiSettings({
      theme: 'dark',
      mcpServers: { kyberion: { command: 'x' } },
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: 'say hi' }] }],
        BeforeTool: [{ hooks: [{ type: 'command', command: 'stale' }] }],
      },
    });
    expect(settings.theme).toBe('dark');
    expect(settings.mcpServers).toEqual({ kyberion: { command: 'x' } });
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.Notification![0]!.hooks[0]!.command).toBe('say hi');
    // owned event is replaced wholesale, not appended
    expect(hooks.BeforeTool).toHaveLength(1);
    expect(hooks.BeforeTool![0]!.hooks[0]!.command).toContain('provider_hook_entry.mjs');
  });
});
