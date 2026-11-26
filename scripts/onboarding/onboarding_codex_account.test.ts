import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectCodexAccount } from './onboarding_codex_account.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeSpawn: mocks.spawn,
}));

function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
    killed: false,
  });
  const requests: unknown[] = [];
  child.stdin.on('data', (chunk) => requests.push(JSON.parse(chunk.toString())));
  mocks.spawn.mockReturnValue(child);
  return { child, requests };
}

afterEach(() => vi.useRealTimers());

it('preserves the exact plan, withholds account identifiers and does not refresh', async () => {
  const { child, requests } = setup();
  const reading = inspectCodexAccount();
  child.stdout.write('{"id":1,"result":{}}\n');
  child.stdout.write('{"id":2,"result":{"account":{"planType":"pro');
  child.stdout.write('lite","type":"chatgpt","email":"private@example.invalid"}}}\n');
  expect(await reading).toEqual({
    status: 'available',
    provider: 'codex',
    account_type: 'chatgpt',
    plan: 'prolite',
    training_use: 'unknown',
  });
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual({
    id: 2,
    method: 'account/read',
    params: { refreshToken: false },
  });
  expect(child.kill).toHaveBeenCalledOnce();
});

it('returns unavailable and cleans up when the process does not respond', async () => {
  vi.useFakeTimers();
  const { child } = setup();
  const reading = inspectCodexAccount();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await reading).toMatchObject({ status: 'unavailable', plan: null });
  expect(child.kill).toHaveBeenCalledOnce();
});
