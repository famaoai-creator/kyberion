import { describe, expect, it, vi } from 'vitest';
import {
  parseAgentRuntimeLaunchMode,
  resetAgentPaneRuntimeBridges,
  resolveAgentRuntimeLaunchMode,
} from './agent-pane-runtime-bridge.js';
import {
  extractPaneAssistantText,
  HerdrAgentPaneRuntimeBridge,
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

/**
 * A mid-turn user-ask must never come back as the agent's answer.
 *
 * `herdr agent prompt --wait` returns as soon as an agent is `blocked`, and
 * the adapter used to read the screen at that point and return whatever was
 * on it — so "Allow edits to this file? (y/n)" was handed to dispatch as
 * completed work.
 */
describe('pane adapter: an agent that stops to ask is not finished', () => {
  const TRUST =
    'Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit';
  const EDIT_ASK = '● Edit(src/app.ts)\n  Do you want to make this edit?\n  ❯ 1. Yes\n    2. No';
  const ANSWER = '> update the header\n\n● Updated the header in src/app.ts.\n\n❯ \n';

  /**
   * A herdr that shows `screens` in order: each send-keys advances one step,
   * which is what answering a prompt looks like from outside.
   */
  function fakeHerdr(opts: { status: string; screens: string[] }) {
    let step = 0;
    const sent: string[][] = [];
    const exec = vi.fn((_command: string, args: string[] = []) => {
      const joined = args.join(' ');
      const ok = (result: unknown) => ({
        status: 0,
        stdout: JSON.stringify({ result }),
        stderr: '',
      });
      const agent = (status: string) => ({
        agent: { name: 'worker', agent_status: status, pane_id: 'w9:p1', workspace_id: 'w9' },
      });
      if (joined.startsWith('workspace list')) {
        return ok({ workspaces: [{ workspace_id: 'w9', label: 'kyberion', pane_count: 1 }] });
      }
      if (joined.startsWith('workspace create') || joined.startsWith('workspace ensure')) {
        return ok({
          workspace: { workspace_id: 'w9', label: 'kyberion' },
          root_pane: { pane_id: 'w9:p1', workspace_id: 'w9' },
        });
      }
      if (joined.startsWith('pane list')) {
        return ok({ panes: [{ pane_id: 'w9:p1', workspace_id: 'w9' }] });
      }
      if (joined.startsWith('agent list')) return ok({ agents: [] });
      if (joined.startsWith('agent start')) return ok(agent('idle'));
      if (joined.startsWith('agent send-keys')) {
        sent.push(args.slice(3));
        step = Math.min(step + 1, opts.screens.length - 1);
        return ok({});
      }
      if (joined.startsWith('agent wait')) return ok(agent('idle'));
      if (joined.startsWith('agent read')) {
        return { status: 0, stdout: opts.screens[step], stderr: '' };
      }
      if (joined.startsWith('agent prompt')) return ok(agent(step === 0 ? opts.status : 'idle'));
      return ok({});
    });
    return { exec, sent };
  }

  function fakeApprovals(decision: 'pending' | 'approved' | 'rejected') {
    const opened: string[] = [];
    const consumed: string[] = [];
    return {
      opened,
      consumed,
      port: {
        open: (request: { signatureId: string }) => {
          opened.push(request.signatureId);
          return { id: 'req-1', created: true };
        },
        status: () => decision,
        consume: (id: string) => {
          consumed.push(id);
        },
      },
    };
  }

  const adapterFor = (
    exec: unknown,
    options: {
      policy?: Record<string, unknown>;
      approvals?: ReturnType<typeof fakeApprovals>;
      cwd?: string;
      provider?: string;
    } = {}
  ) =>
    new HerdrAgentPaneRuntimeBridge({
      exec: exec as never,
      promptPolicy: {
        version: '1.0.0',
        escalation_wait_ms: 0,
        relay_keys: { default: { approve: ['enter'], reject: ['esc'] } },
        ...(options.policy ?? {}),
      } as never,
      promptApprovals: (options.approvals ?? fakeApprovals('pending')).port as never,
      promptAudit: () => undefined,
      settleDelayMs: 0,
    }).createAdapter({
      agentId: 'worker',
      provider: options.provider ?? 'claude',
      cwd: options.cwd ?? '/tmp/repo',
    });

  it('escalates when herdr itself reports the agent blocked', async () => {
    const { exec, sent } = fakeHerdr({ status: 'blocked', screens: ['❯ \n', EDIT_ASK] });
    // Boot sees an idle input; the turn stops on the edit question.
    let reads = 0;
    const execWithTurn = vi.fn((command: string, args: string[] = []) => {
      if (args[0] === 'agent' && args[1] === 'read') {
        reads += 1;
        return { status: 0, stdout: reads === 1 ? '❯ \n' : EDIT_ASK, stderr: '' };
      }
      return exec(command, args);
    });
    const approvals = fakeApprovals('pending');
    await expect(adapterFor(execWithTurn, { approvals }).ask('update the header')).rejects.toThrow(
      /AGENT_RUNTIME_AWAITING_HUMAN[\s\S]*pnpm kyberion approve req-1/
    );
    expect(approvals.opened).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  it('escalates a trust prompt herdr reported as idle, before the first turn', async () => {
    const { exec, sent } = fakeHerdr({ status: 'idle', screens: [TRUST] });
    const approvals = fakeApprovals('pending');
    await expect(adapterFor(exec, { approvals }).ask('update the header')).rejects.toThrow(
      /trust the contents/i
    );
    expect(approvals.opened).toEqual(['workspace_trust']);
    expect(sent).toEqual([]);
  });

  it('still returns a genuine answer', async () => {
    const { exec } = fakeHerdr({ status: 'done', screens: [ANSWER] });
    const response = await adapterFor(exec).ask('update the header');
    expect(response.text).toMatch(/Updated the header/);
  });

  it('answers a trust prompt an allowlist rule covers, and carries on', async () => {
    const { exec, sent } = fakeHerdr({ status: 'idle', screens: [TRUST, ANSWER] });
    const approvals = fakeApprovals('pending');
    const response = await adapterFor(exec, {
      approvals,
      cwd: '/work/checkouts/repo-a',
      policy: {
        auto_answer: [
          {
            id: 'trust-checkouts',
            signature: 'workspace_trust',
            cwd_prefixes: ['/work/checkouts'],
            keys: ['enter'],
          },
        ],
      },
    }).ask('update the header');
    expect(sent).toEqual([['enter']]);
    expect(approvals.opened).toEqual([]);
    expect(response.text).toMatch(/Updated the header/);
  });

  it('does not stretch a trust rule to a path it does not name', async () => {
    const { exec, sent } = fakeHerdr({ status: 'idle', screens: [TRUST, ANSWER] });
    const approvals = fakeApprovals('pending');
    await expect(
      adapterFor(exec, {
        approvals,
        cwd: '/elsewhere/repo',
        policy: {
          auto_answer: [
            {
              id: 'trust-checkouts',
              signature: 'workspace_trust',
              cwd_prefixes: ['/work/checkouts'],
              keys: ['enter'],
            },
          ],
        },
      }).ask('update the header')
    ).rejects.toThrow(/AGENT_RUNTIME_AWAITING_HUMAN/);
    expect(sent).toEqual([]);
  });

  it("relays a person's approval as keys, once", async () => {
    const { exec, sent } = fakeHerdr({ status: 'idle', screens: [TRUST, ANSWER] });
    const approvals = fakeApprovals('approved');
    const response = await adapterFor(exec, { approvals }).ask('update the header');
    expect(sent).toEqual([['enter']]);
    expect(approvals.consumed).toEqual(['req-1']);
    expect(response.text).toMatch(/Updated the header/);
  });

  it("relays a person's rejection and stops", async () => {
    const { exec, sent } = fakeHerdr({ status: 'idle', screens: [TRUST, '-zsh %'] });
    const approvals = fakeApprovals('rejected');
    await expect(adapterFor(exec, { approvals }).ask('update the header')).rejects.toThrow(
      /AGENT_RUNTIME_PROMPT_DECLINED/
    );
    expect(sent).toEqual([['esc']]);
    expect(approvals.consumed).toEqual(['req-1']);
  });

  it('never answers a sign-in prompt, even with a rule and an approval', async () => {
    const { exec, sent } = fakeHerdr({ status: 'idle', screens: ['Please sign in to continue'] });
    const approvals = fakeApprovals('approved');
    await expect(
      adapterFor(exec, {
        approvals,
        policy: {
          auto_answer: [{ id: 'bad', signature: 'sign_in', keys: ['enter'] }],
        },
      }).ask('update the header')
    ).rejects.toThrow(/AGENT_RUNTIME_AWAITING_HUMAN/);
    expect(sent).toEqual([]);
    expect(approvals.opened).toEqual([]);
  });

  it('stops rather than answering twice when an answer does not take', async () => {
    const { exec, sent } = fakeHerdr({ status: 'idle', screens: [TRUST, TRUST] });
    await expect(
      adapterFor(exec, { approvals: fakeApprovals('approved') }).ask('update the header')
    ).rejects.toThrow(/did not take effect/);
    expect(sent).toEqual([['enter']]);
  });

  it('starts the agent with the launch args the policy names', async () => {
    const { exec } = fakeHerdr({ status: 'done', screens: [ANSWER] });
    await adapterFor(exec, {
      policy: { launch_args: { claude: ['--permission-mode', 'acceptEdits'] } },
    }).ask('update the header');
    const start = exec.mock.calls.find(([, args]) => (args as string[])[1] === 'start');
    expect(start?.[1]).toEqual(expect.arrayContaining(['--', '--permission-mode', 'acceptEdits']));
  });
});
