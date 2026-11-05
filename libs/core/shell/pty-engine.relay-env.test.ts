import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ nativeSpawn: vi.fn(), childSpawn: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: mocks.nativeSpawn }));
vi.mock('node:child_process', () => ({ spawn: mocks.childSpawn }));
vi.mock('../core.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
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

const KEY = 'sk-ant-pty-real-key-0123456789';
const ids: string[] = [];

function spawnAndCaptureEnv(env: Record<string, string> = {}): Record<string, string> {
  mocks.nativeSpawn.mockReturnValueOnce({
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    pid: 1,
  });
  ids.push(ptyEngine.spawn('/bin/sh', [], '/tmp', env));
  return mocks.nativeSpawn.mock.calls.at(-1)?.[2]?.env as Record<string, string>;
}

afterEach(() => {
  for (const id of ids.splice(0)) ptyEngine.kill(id);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('pty-engine env with the credential relay flag', () => {
  it('inherits the key when the flag is off', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    expect(spawnAndCaptureEnv().ANTHROPIC_API_KEY).toBe(KEY);
  });

  it('drops inherited and caller-supplied relay-managed keys when the flag is on', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    vi.stubEnv('KYBERION_PROVIDER_CREDENTIAL_RELAY', '1');
    const env = spawnAndCaptureEnv({ OPENAI_API_KEY: 'sk-openai-caller-supplied-0123456789' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
  });
});
