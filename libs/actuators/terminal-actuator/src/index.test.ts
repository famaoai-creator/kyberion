import { describe, expect, it, vi, beforeEach } from 'vitest';

const ptyState = {
  sessions: new Map<string, any>(),
};

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
