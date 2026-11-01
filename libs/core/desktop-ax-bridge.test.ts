import { describe, expect, it, vi, beforeEach } from 'vitest';

const execResult = vi.fn();
const existsSync = vi.fn(() => true);
const mkdir = vi.fn();
const resolveBin = vi.fn(() => '/managed/tool-runtimes/agent-desktop/bin/agent-desktop');

vi.mock('./secure-io.js', () => ({
  safeExecResult: (...args: unknown[]) => execResult(...args),
  safeExistsSync: (...args: unknown[]) => existsSync(...args),
  safeMkdir: (...args: unknown[]) => mkdir(...args),
}));

vi.mock('./tool/tool-binary-resolvers.js', () => ({
  resolveAgentDesktopBin: () => resolveBin(),
}));

vi.mock('./path-resolver.js', () => ({
  pathResolver: {
    rootResolve: (sub: string) => `/repo/${sub}`,
  },
}));

describe('desktop-ax-bridge', () => {
  beforeEach(() => {
    execResult.mockReset();
    existsSync.mockReset().mockReturnValue(true);
    resolveBin
      .mockReset()
      .mockReturnValue('/managed/tool-runtimes/agent-desktop/bin/agent-desktop');
  });

  it('reports unavailable when the managed binary is absent', async () => {
    existsSync.mockReturnValue(false);
    const { agentDesktopAvailability } = await import('./desktop-ax-bridge.js');
    const availability = agentDesktopAvailability();
    expect(availability.available).toBe(false);
    expect(availability.detail).toContain('tool:setup');
  });

  it('reports availability with version when the probe succeeds', async () => {
    execResult.mockReturnValue({ status: 0, stdout: 'agent-desktop 1.0.2', stderr: '' });
    const { agentDesktopAvailability } = await import('./desktop-ax-bridge.js');
    const availability = agentDesktopAvailability();
    expect(availability.available).toBe(true);
    expect(availability.bin).toBe('/managed/tool-runtimes/agent-desktop/bin/agent-desktop');
    expect(execResult).toHaveBeenCalledWith(
      '/managed/tool-runtimes/agent-desktop/bin/agent-desktop',
      ['version'],
      expect.objectContaining({
        env: expect.objectContaining({ AGENT_DESKTOP_HOME: expect.any(String) }),
      })
    );
  });

  it('fails closed when the probe errors', async () => {
    execResult.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });
    const { agentDesktopAvailability } = await import('./desktop-ax-bridge.js');
    expect(agentDesktopAvailability().available).toBe(false);
  });

  it('rejects non-allowlisted subcommands before spawn', async () => {
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    const result = runAgentDesktopCommand(['exec', 'rm -rf /']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    expect(execResult).not.toHaveBeenCalled();
  });

  it('returns TOOL_UNAVAILABLE without spawning when binary absent', async () => {
    existsSync.mockReturnValue(false);
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    const result = runAgentDesktopCommand(['snapshot']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TOOL_UNAVAILABLE');
    expect(execResult).not.toHaveBeenCalled();
  });

  it('parses a success envelope', async () => {
    execResult.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ ok: true, data: { snapshot_id: 's8f3k2p9', elements: [] } }),
      stderr: '',
    });
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    const result = runAgentDesktopCommand(['snapshot', '--app', 'Finder']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.data).toEqual({ snapshot_id: 's8f3k2p9', elements: [] });
  });

  it('passes through structured envelope errors with disposition', async () => {
    execResult.mockReturnValue({
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        error: { code: 'STALE_REF', message: 'ref is stale' },
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      }),
      stderr: '',
    });
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    const result = runAgentDesktopCommand(['click', '@s8f3k2p9:e8']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STALE_REF');
      expect(result.disposition?.delivery).toBe('not_delivered');
    }
  });

  it('classifies malformed output as ENVELOPE_MALFORMED', async () => {
    execResult.mockReturnValue({ status: 0, stdout: 'not json', stderr: '' });
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    const result = runAgentDesktopCommand(['snapshot']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ENVELOPE_MALFORMED');
  });

  it('bootstraps a session when sessionId is provided', async () => {
    execResult
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { session_id: 'run-1' } }),
        stderr: '',
      }) // session start
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: {} }),
        stderr: '',
      });
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    runAgentDesktopCommand(['snapshot'], { sessionId: 'mission-x1' });
    expect(execResult).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ['session', 'start', '--name', 'mission-x1'],
      expect.objectContaining({
        env: expect.objectContaining({ AGENT_DESKTOP_HOME: expect.any(String) }),
      })
    );
    expect(execResult).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      ['snapshot'],
      expect.objectContaining({
        env: expect.objectContaining({ AGENT_DESKTOP_SESSION: 'run-1' }),
      })
    );
  });

  it('reuses the minted runtime session for subsequent calls', async () => {
    execResult
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { session_id: 'run-2' } }),
        stderr: '',
      })
      .mockReturnValue({ status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' });
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    runAgentDesktopCommand(['snapshot'], { sessionId: 'mission-x2' });
    runAgentDesktopCommand(['list-windows'], { sessionId: 'mission-x2' });
    // Second call skips session start: calls = [start, snapshot, list-windows]
    expect(execResult).toHaveBeenCalledTimes(3);
    expect(execResult).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      ['list-windows'],
      expect.objectContaining({
        env: expect.objectContaining({ AGENT_DESKTOP_SESSION: 'run-2' }),
      })
    );
  });

  it('evicts a stale cached session and retries the command once', async () => {
    execResult
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { session_id: 'run-stale' } }),
        stderr: '',
      }) // session start
      .mockReturnValueOnce({
        status: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'session gc removed it' },
        }),
        stderr: '',
      }) // snapshot with stale session
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { session_id: 'run-fresh' } }),
        stderr: '',
      }) // re-minted session start
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { done: true } }),
        stderr: '',
      }); // retried snapshot
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    const result = runAgentDesktopCommand(['snapshot'], { sessionId: 'mission-retry' });
    expect(result.ok).toBe(true);
    expect(execResult).toHaveBeenNthCalledWith(
      4,
      expect.any(String),
      ['snapshot'],
      expect.objectContaining({
        env: expect.objectContaining({ AGENT_DESKTOP_SESSION: 'run-fresh' }),
      })
    );
  });

  it('does not retry a stale session more than once', async () => {
    execResult
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { session_id: 'run-s1' } }),
        stderr: '',
      }) // session start
      .mockReturnValueOnce({
        status: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'gone' },
        }),
        stderr: '',
      }) // snapshot fails with stale session
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { session_id: 'run-s2' } }),
        stderr: '',
      }) // re-mint succeeds
      .mockReturnValue({
        status: 1,
        stdout: JSON.stringify({
          ok: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'gone again' },
        }),
        stderr: '',
      }); // retried snapshot fails again — must not loop
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    const result = runAgentDesktopCommand(['snapshot'], { sessionId: 'mission-loop' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SESSION_NOT_FOUND');
    // start + failed snapshot + re-mint + failed snapshot retry — no fifth call
    expect(execResult).toHaveBeenCalledTimes(4);
  });

  it('fails SESSION_UNAVAILABLE when session start fails', async () => {
    execResult.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'denied' });
    const { runAgentDesktopCommand } = await import('./desktop-ax-bridge.js');
    const result = runAgentDesktopCommand(['snapshot'], { sessionId: 'mission-x3' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SESSION_UNAVAILABLE');
  });

  it('ends the minted runtime session and evicts the mapping', async () => {
    execResult
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { session_id: 'run-end' } }),
        stderr: '',
      }) // session start
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' }) // cmd
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { ended_at: 1 } }),
        stderr: '',
      }); // session end
    const { runAgentDesktopCommand, endAgentDesktopSession } =
      await import('./desktop-ax-bridge.js');
    runAgentDesktopCommand(['snapshot'], { sessionId: 'mission-end' });
    const result = endAgentDesktopSession('mission-end');
    expect(result.ok).toBe(true);
    expect(execResult).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      ['session', 'end', 'run-end'],
      expect.any(Object)
    );
  });

  it('resolves sessions by name when the caller map is cold', async () => {
    execResult
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          data: {
            sessions: [
              { name: 'mission-cold', session_id: 'run-old', ended_at: null },
              { name: 'other', session_id: 'run-other', ended_at: null },
              { name: 'mission-cold', session_id: 'run-done', ended_at: 5 },
            ],
          },
        }),
        stderr: '',
      }) // session list
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' }); // end
    const { endAgentDesktopSession } = await import('./desktop-ax-bridge.js');
    const result = endAgentDesktopSession('mission-cold');
    expect(result.ok).toBe(true);
    expect(execResult).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      ['session', 'end', 'run-old'],
      expect.any(Object)
    );
  });

  it('is a no-op when the caller has no live session', async () => {
    execResult.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ ok: true, data: { sessions: [] } }),
      stderr: '',
    });
    const { endAgentDesktopSession } = await import('./desktop-ax-bridge.js');
    expect(endAgentDesktopSession('never-started').ok).toBe(true);
    expect(execResult).toHaveBeenCalledTimes(1); // list only, no end call
  });

  it('drains all minted sessions then runs gc on process exit', async () => {
    execResult
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { session_id: 'run-drain' } }),
        stderr: '',
      }) // session start (mint)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' }) // end
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, data: { removed: ['run-drain'] } }),
        stderr: '',
      }); // gc
    const { ensureAgentDesktopSession, drainAgentDesktopSessions } =
      await import('./desktop-ax-bridge.js');
    expect(ensureAgentDesktopSession('caller-drain').ok).toBe(true);
    drainAgentDesktopSessions();
    const calls = execResult.mock.calls.map((c) => c[1]);
    expect(calls).toContainEqual(['session', 'end', 'run-drain']);
    expect(calls).toContainEqual(['session', 'gc']);
  });

  it('runs session gc through the governed env', async () => {
    execResult.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ ok: true, data: { removed: ['run-x'] } }),
      stderr: '',
    });
    const { gcAgentDesktopSessions } = await import('./desktop-ax-bridge.js');
    const result = gcAgentDesktopSessions();
    expect(result.ok).toBe(true);
    expect(execResult).toHaveBeenCalledWith(
      expect.any(String),
      ['session', 'gc'],
      expect.objectContaining({
        env: expect.objectContaining({ AGENT_DESKTOP_HOME: expect.any(String) }),
      })
    );
  });
});
