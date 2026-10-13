import { describe, expect, it } from 'vitest';
import { buildGeminiSettings } from './generate_provider_hook_configs.js';

describe('buildGeminiSettings', () => {
  it('renders the four owned hook event groups', () => {
    const settings = buildGeminiSettings();
    const hooks = settings.hooks as Record<string, unknown[]>;
    for (const event of ['SessionStart', 'BeforeAgent', 'BeforeTool', 'SessionEnd']) {
      expect(hooks[event]).toHaveLength(1);
      const group = hooks[event]![0] as { hooks: Array<{ command: string }> };
      expect(group.hooks[0]!.command).toContain('gemini_cli_hook.js');
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
    expect(hooks.BeforeTool![0]!.hooks[0]!.command).toContain('gemini_cli_hook.js');
  });
});
