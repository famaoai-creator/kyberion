import { describe, expect, it, vi } from 'vitest';
import {
  parseAgentRuntimeLaunchMode,
  resetAgentPaneRuntimeBridges,
  resolveAgentRuntimeLaunchMode,
} from './agent-pane-runtime-bridge.js';
import {
  extractPaneAssistantText,
  HerdrRuntimeClient,
  mapProviderToHerdrKind,
  registerHerdrAgentPaneRuntimeBridge,
  sanitizeHerdrAgentName,
} from './agent-pane-runtime-herdr.js';
import { createAgentPaneRuntimeAdapter } from './agent-pane-runtime-bridge.js';

describe('agent-pane-runtime-bridge', () => {
  it('resolves launch mode with option > metadata > env precedence', () => {
    expect(
      resolveAgentRuntimeLaunchMode({
        runtimeBackend: 'pipe',
        runtimeMetadata: { runtime_backend: 'pane' },
        env: { KYBERION_AGENT_RUNTIME_BACKEND: 'pane' },
      })
    ).toBe('pipe');
    expect(
      resolveAgentRuntimeLaunchMode({
        runtimeMetadata: { runtime_backend: 'pane' },
        env: { KYBERION_AGENT_RUNTIME_BACKEND: 'pipe' },
      })
    ).toBe('pane');
    expect(
      resolveAgentRuntimeLaunchMode({
        env: { KYBERION_AGENT_RUNTIME_BACKEND: 'pane' },
      })
    ).toBe('pane');
    expect(resolveAgentRuntimeLaunchMode({ env: {} })).toBe('pipe');
    expect(parseAgentRuntimeLaunchMode('herdr')).toBeUndefined();
  });
});

describe('agent-pane-runtime herdr provider', () => {
  it('maps known providers and sanitizes agent names', () => {
    expect(mapProviderToHerdrKind('claude')).toBe('claude');
    expect(mapProviderToHerdrKind('unknown-x')).toBeNull();
    expect(sanitizeHerdrAgentName('Implementer-01')).toBe('implementer-01');
    expect(sanitizeHerdrAgentName('42-bot')).toBe('a42-bot');
  });

  it('extracts assistant text after the prompt', () => {
    const screen = [
      '❯ Reply with exactly: OK',
      '',
      '⏺ OK',
      '',
      '────────────────────────────────────────',
      '❯ ',
    ].join('\n');
    expect(extractPaneAssistantText(screen, 'Reply with exactly: OK')).toBe('OK');
  });

  it('boots a pane adapter through the seam', async () => {
    resetAgentPaneRuntimeBridges();
    const exec = vi.fn((_command: string, args: string[] = []) => {
      const joined = args.join(' ');
      if (joined.startsWith('workspace list')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            result: {
              workspaces: [{ workspace_id: 'w1', label: 'kyberion', active_tab_id: 'w1:t1' }],
            },
          }),
          stderr: '',
        };
      }
      if (joined.startsWith('pane list')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            result: { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1' }] },
          }),
          stderr: '',
        };
      }
      if (joined.startsWith('agent list')) {
        return {
          status: 0,
          stdout: JSON.stringify({ result: { agents: [] } }),
          stderr: '',
        };
      }
      if (joined.startsWith('agent start')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            result: {
              agent: {
                name: 'reviewer',
                pane_id: 'w1:p1',
                workspace_id: 'w1',
                agent: 'claude',
                agent_status: 'idle',
              },
            },
          }),
          stderr: '',
        };
      }
      if (joined.startsWith('agent prompt')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            result: {
              agent: {
                name: 'reviewer',
                pane_id: 'w1:p1',
                workspace_id: 'w1',
                agent_status: 'done',
              },
            },
          }),
          stderr: '',
        };
      }
      if (joined.startsWith('agent read')) {
        return {
          status: 0,
          stdout: '❯ say hi\n\n⏺ hello from pane\n\n────────────────\n❯ ',
          stderr: '',
        };
      }
      if (joined.startsWith('agent get')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            result: {
              agent: {
                name: 'reviewer',
                pane_id: 'w1:p1',
                workspace_id: 'w1',
                agent_status: 'done',
              },
            },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected: ${joined}`);
    });

    registerHerdrAgentPaneRuntimeBridge({ exec: exec as never });
    const adapter = await createAgentPaneRuntimeAdapter({
      agentId: 'reviewer',
      provider: 'claude',
      cwd: '/tmp/repo',
    });
    await adapter.boot();
    const answer = await adapter.ask('say hi');
    expect(answer.text).toContain('hello from pane');
    expect(adapter.getRuntimeInfo?.()?.backend).toBe('pane');
  });

  it('parses workspace create via client', () => {
    const exec = vi.fn((_command: string, args: string[] = []) => {
      const joined = args.join(' ');
      if (joined.startsWith('workspace list')) {
        return {
          status: 0,
          stdout: JSON.stringify({ result: { workspaces: [] } }),
          stderr: '',
        };
      }
      if (joined.startsWith('workspace create')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            result: {
              workspace: { workspace_id: 'w9', label: 'kyberion' },
              root_pane: { pane_id: 'w9:p1', workspace_id: 'w9' },
            },
          }),
          stderr: '',
        };
      }
      throw new Error(joined);
    });
    const client = new HerdrRuntimeClient({ exec: exec as never });
    const ensured = client.ensureWorkspace({ cwd: '/tmp/repo', label: 'kyberion' });
    expect(ensured.created).toBe(true);
    expect(ensured.root_pane.pane_id).toBe('w9:p1');
  });
});
