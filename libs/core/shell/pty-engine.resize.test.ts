import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nativeSpawn: vi.fn(),
  resize: vi.fn(),
  childSpawn: vi.fn(),
}));
vi.mock('node-pty', () => ({ spawn: mocks.nativeSpawn }));
vi.mock('node:child_process', () => ({ spawn: mocks.childSpawn }));
vi.mock('../core.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../tool/runtime-supervisor.js', () => ({
  runtimeSupervisor: {
    register: vi.fn(),
    touch: vi.fn(),
    unregister: vi.fn(),
    update: vi.fn(),
    startSweep: vi.fn(),
  },
}));
import { ptyEngine } from './pty-engine.js';

const ids: string[] = [];
afterEach(() => {
  for (const id of ids.splice(0)) ptyEngine.kill(id);
  vi.clearAllMocks();
});
describe('PTY resize capability', () => {
  it('resizes a native PTY and reports success', () => {
    mocks.nativeSpawn.mockReturnValue({
      write: vi.fn(),
      resize: mocks.resize,
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      pid: 1,
    });
    const id = ptyEngine.spawn('/bin/sh', [], '/tmp');
    ids.push(id);
    expect(ptyEngine.resize(id, 100, 30)).toBe(true);
    expect(mocks.resize).toHaveBeenCalledExactlyOnceWith(100, 30);
  });
  it('reports unsupported resize for pipe fallback', () => {
    mocks.nativeSpawn.mockImplementationOnce(() => {
      throw new Error('native unavailable');
    });
    mocks.childSpawn.mockReturnValue({
      stdin: { write: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      pid: 2,
    });
    const id = ptyEngine.spawn('/bin/sh', [], '/tmp');
    ids.push(id);
    expect(ptyEngine.get(id)?.adapter.supportsResize).toBe(false);
    expect(ptyEngine.resize(id, 100, 30)).toBe(false);
    expect(mocks.resize).not.toHaveBeenCalled();
  });
});
