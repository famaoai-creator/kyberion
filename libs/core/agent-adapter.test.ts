import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgyAdapter } from './agent-adapter.js';
import { spawnSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

describe('AgyAdapter', () => {
  let adapter: AgyAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AgyAdapter({ bin: 'agy' });
  });

  it('correctly executes a basic stateless single-prompt run', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Hello World',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    const response = await adapter.ask('Say hello');
    expect(response.text).toBe('Hello World');
    expect(response.stopReason).toBe('completed');

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Say hello', '--dangerously-skip-permissions'],
      expect.any(Object),
    );
  });

  it('correctly passes conversationId for session persistence', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Response',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    await adapter.ask('Continuing...', { conversationId: 'session-123' });

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Continuing...', '--dangerously-skip-permissions', '--conversation', 'session-123'],
      expect.any(Object),
    );

    const runtimeInfo = adapter.getRuntimeInfo();
    expect(runtimeInfo.stateless).toBe(false);
    expect(runtimeInfo.sessionId).toBe('session-123');
  });

  it('correctly passes addDirs to mount dynamic directories', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Response',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    await adapter.ask('Check files', { addDirs: ['/path/to/dir1', '/path/to/dir2'] });

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Check files', '--dangerously-skip-permissions', '--add-dir', '/path/to/dir1', '--add-dir', '/path/to/dir2'],
      expect.any(Object),
    );
  });

  it('correctly passes sandbox flag', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Response',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    await adapter.ask('Risky run', { sandbox: true });

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Risky run', '--dangerously-skip-permissions', '--sandbox'],
      expect.any(Object),
    );
  });

  it('correctly executes in interactive mode with inherited stdio', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    const response = await adapter.ask('Interactive prompt', { interactive: true });
    expect(response.text).toBe('Interactive session completed.');
    expect(response.stopReason).toBe('completed');

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-i', 'Interactive prompt', '--dangerously-skip-permissions'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });
});
