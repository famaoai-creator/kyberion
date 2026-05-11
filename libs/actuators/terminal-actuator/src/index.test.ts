import { describe, expect, it, vi, beforeEach } from 'vitest';

const ptyState = {
  sessions: new Map<string, any>(),
};

const mocks = vi.hoisted(() => ({
  withRetry: vi.fn(async (fn: any) => fn()),
  classifyError: vi.fn(() => ({ category: 'timeout' })),
}));

vi.mock('@agent/core', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  createStandardYargs: vi.fn(),
  pathResolver: {
    rootDir: vi.fn(() => '/tmp/terminal-actuator-test'),
    rootResolve: vi.fn((value: string) => value),
  },
  safeReadFile: vi.fn(),
  encodeTerminalInput: vi.fn((keys: string[]) => keys.join('+')),
  emitComputerSurfacePatch: vi.fn(),
  classifyError: mocks.classifyError,
  withRetry: mocks.withRetry,
  ptyEngine: {
    spawn: vi.fn((shell: string, args: string[], cwd?: string) => {
      const id = `pty-${ptyState.sessions.size + 1}`;
      ptyState.sessions.set(id, {
        id,
        status: 'running',
        exitCode: undefined,
        adapter: { pid: 4321 },
        shell,
        args,
        cwd,
      });
      return id;
    }),
    poll: vi.fn((sessionId: string) => ({
      output: `output:${sessionId}`,
      nextOffset: 0,
      total: 0,
    })),
    get: vi.fn((sessionId: string) => ptyState.sessions.get(sessionId)),
    write: vi.fn(() => true),
    resize: vi.fn(() => true),
    kill: vi.fn((sessionId: string) => {
      ptyState.sessions.delete(sessionId);
      return true;
    }),
    list: vi.fn(() => Array.from(ptyState.sessions.keys())),
    popMessages: vi.fn(() => []),
  },
}));

describe('terminal-actuator computer_interaction adapter', () => {
  beforeEach(() => {
    ptyState.sessions.clear();
  });

  it('spawns shell_command interactions as terminal sessions', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'shell_command',
        text: 'echo hello',
      },
    } as any);

    expect(result.status).toBe('created');
    expect(result.sessionId).toBeDefined();
  });

  it('lists terminal sessions through the computer_interaction contract', async () => {
    const { handleAction } = await import('./index');
    await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'shell_command',
        text: 'echo hello',
      },
    } as any);

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'list_terminal_sessions',
      },
    } as any);

    expect(result.status).toBe('listed');
    expect(result.sessions).toHaveLength(1);
  });
});

describe('terminal-actuator direct actions', () => {
  beforeEach(() => {
    ptyState.sessions.clear();
  });

  it('spawn action creates a new terminal session', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      action: 'spawn',
      params: {
        shell: '/bin/bash',
        cwd: '/tmp',
      },
    } as any);

    expect(result.status).toBe('created');
    expect(result.sessionId).toBeDefined();
  });

  it('list action returns all sessions', async () => {
    const { handleAction } = await import('./index');
    await handleAction({ action: 'spawn', params: {} } as any);
    await handleAction({ action: 'spawn', params: {} } as any);

    const result = await handleAction({ action: 'list', params: {} } as any);
    expect(result.sessions).toHaveLength(2);
    expect(mocks.withRetry).toHaveBeenCalled();
  });

  it('poll action requires sessionId', async () => {
    const { handleAction } = await import('./index');
    await expect(handleAction({ action: 'poll', params: {} } as any)).rejects.toThrow(
      'sessionId is required'
    );
  });

  it('poll action returns session output', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({ action: 'spawn', params: {} } as any);
    const result = await handleAction({
      action: 'poll',
      params: { sessionId: spawned.sessionId },
    } as any);

    expect(result.output).toBeDefined();
  });

  it('write action requires sessionId', async () => {
    const { handleAction } = await import('./index');
    await expect(
      handleAction({ action: 'write', params: { data: 'hello' } } as any)
    ).rejects.toThrow('sessionId is required');
  });

  it('write action requires data or keys', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({ action: 'spawn', params: {} } as any);
    await expect(
      handleAction({ action: 'write', params: { sessionId: spawned.sessionId } } as any)
    ).rejects.toThrow('data or keys is required');
  });

  it('write action with data succeeds', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({ action: 'spawn', params: {} } as any);
    const result = await handleAction({
      action: 'write',
      params: { sessionId: spawned.sessionId, data: 'echo hello\n' },
    } as any);

    expect(result.success).toBe(true);
  });

  it('write action with keys succeeds', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({ action: 'spawn', params: {} } as any);
    const result = await handleAction({
      action: 'write',
      params: { sessionId: spawned.sessionId, keys: ['Enter'] },
    } as any);

    expect(result.success).toBe(true);
  });

  it('resize action requires sessionId', async () => {
    const { handleAction } = await import('./index');
    await expect(
      handleAction({ action: 'resize', params: { cols: 80, rows: 24 } } as any)
    ).rejects.toThrow('sessionId is required');
  });

  it('resize action requires cols and rows', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({ action: 'spawn', params: {} } as any);
    await expect(
      handleAction({ action: 'resize', params: { sessionId: spawned.sessionId } } as any)
    ).rejects.toThrow('cols and rows are required');
  });

  it('resize action succeeds with valid params', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({ action: 'spawn', params: {} } as any);
    const result = await handleAction({
      action: 'resize',
      params: { sessionId: spawned.sessionId, cols: 120, rows: 40 },
    } as any);

    expect(result.success).toBe(true);
  });

  it('kill action requires sessionId', async () => {
    const { handleAction } = await import('./index');
    await expect(handleAction({ action: 'kill', params: {} } as any)).rejects.toThrow(
      'sessionId is required'
    );
  });

  it('kill action terminates a session', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({ action: 'spawn', params: {} } as any);
    const result = await handleAction({
      action: 'kill',
      params: { sessionId: spawned.sessionId },
    } as any);

    expect(result.success).toBe(true);
  });

  it('unsupported action throws error', async () => {
    const { handleAction } = await import('./index');
    await expect(
      handleAction({ action: 'unsupported_action' as any, params: {} } as any)
    ).rejects.toThrow('Unsupported terminal action');
  });

  it('poll action with threadId and persona returns messages', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({
      action: 'spawn',
      params: { threadId: 'thread-1' },
    } as any);

    const result = await handleAction({
      action: 'poll',
      params: {
        sessionId: spawned.sessionId,
        threadId: 'thread-1',
        persona: 'KYBERION-PRIME',
      },
    } as any);

    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(mocks.withRetry).toHaveBeenCalled();
  });
});

describe('terminal-actuator computer_interaction edge cases', () => {
  beforeEach(() => {
    ptyState.sessions.clear();
  });

  it('poll_terminal requires session_id', async () => {
    const { handleAction } = await import('./index');
    await expect(
      handleAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'poll_terminal' },
      } as any)
    ).rejects.toThrow('session_id');
  });

  it('write_terminal requires session_id', async () => {
    const { handleAction } = await import('./index');
    await expect(
      handleAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'write_terminal', text: 'hello' },
      } as any)
    ).rejects.toThrow('session_id');
  });

  it('kill_terminal requires session_id', async () => {
    const { handleAction } = await import('./index');
    await expect(
      handleAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'kill_terminal' },
      } as any)
    ).rejects.toThrow('session_id');
  });

  it('spawn_terminal creates a session', async () => {
    const { handleAction } = await import('./index');
    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: {
        type: 'spawn_terminal',
        shell: '/bin/bash',
        cwd: '/tmp',
      },
    } as any);

    expect(result.status).toBe('created');
    expect(result.sessionId).toBeDefined();
    expect(mocks.withRetry).toHaveBeenCalled();
  });

  it('poll_terminal returns session output', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'spawn_terminal' },
    } as any);

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: spawned.sessionId,
      action: { type: 'poll_terminal' },
    } as any);

    expect(result.output).toBeDefined();
    expect(mocks.withRetry).toHaveBeenCalled();
  });

  it('write_terminal sends data to session', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'spawn_terminal' },
    } as any);

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: spawned.sessionId,
      action: { type: 'write_terminal', text: 'echo hello\n' },
    } as any);

    expect(result.success).toBe(true);
  });

  it('kill_terminal terminates a session', async () => {
    const { handleAction } = await import('./index');
    const spawned = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      action: { type: 'spawn_terminal' },
    } as any);

    const result = await handleAction({
      version: '0.1',
      kind: 'computer_interaction',
      session_id: spawned.sessionId,
      action: { type: 'kill_terminal' },
    } as any);

    expect(result.success).toBe(true);
  });

  it('unsupported computer_interaction action throws error', async () => {
    const { handleAction } = await import('./index');
    await expect(
      handleAction({
        version: '0.1',
        kind: 'computer_interaction',
        action: { type: 'unsupported_action' },
      } as any)
    ).rejects.toThrow('Unsupported computer interaction action');
  });
});
