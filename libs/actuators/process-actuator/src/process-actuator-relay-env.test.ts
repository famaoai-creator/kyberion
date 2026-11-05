import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnManagedProcess: vi.fn() }));

vi.mock('@agent/core/managed-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/managed-process')>();
  return { ...actual, spawnManagedProcess: mocks.spawnManagedProcess };
});

import { handleAction } from './process-actuator-helpers.js';

const KEY = 'sk-ant-process-actuator-real-key-0123456789';

async function spawnedEnv(extraEnv?: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  let captured: NodeJS.ProcessEnv | undefined;
  mocks.spawnManagedProcess.mockImplementationOnce(
    (input: { resourceId: string; spawnOptions: { env: NodeJS.ProcessEnv } }) => {
      captured = input.spawnOptions.env;
      const child = Object.assign(new EventEmitter(), { pid: 424242 });
      queueMicrotask(() => child.emit('spawn'));
      return { resourceId: input.resourceId, child };
    }
  );
  await handleAction({
    action: 'spawn',
    params: {
      resourceId: `relay-env-${Math.random().toString(36).slice(2)}`,
      command: 'true',
      kind: 'pty',
      ownerId: 'test',
      ownerType: 'test',
      ...(extraEnv ? { env: extraEnv } : {}),
    },
  });
  if (!captured) throw new Error('spawnManagedProcess was not called');
  return captured;
}

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.spawnManagedProcess.mockReset();
});

describe('process-actuator spawn env with the credential relay flag', () => {
  it('passes the inherited key through when the flag is off', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    expect((await spawnedEnv()).ANTHROPIC_API_KEY).toBe(KEY);
  });

  it('drops inherited and caller-supplied relay-managed keys when the flag is on', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    vi.stubEnv('KYBERION_PROVIDER_CREDENTIAL_RELAY', '1');
    const env = await spawnedEnv({ OPENAI_API_KEY: 'sk-openai-caller-supplied-0123456789' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
