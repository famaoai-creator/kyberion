import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ adapterDefault: undefined as string | undefined }));

vi.mock('../actuator/adapter-default-preferences.js', () => ({
  getAdapterDefault: vi.fn(() => mocks.adapterDefault),
}));

import { EmailAccountRegistry } from './email-workflow.js';

function fakeAdapter(id: string, ready: boolean) {
  return {
    id,
    display_name: id,
    capabilities: [],
    isReady: async () => ready,
    deliver: async () => ({}),
  };
}

function registry(ready: Record<string, boolean>): EmailAccountRegistry {
  return new EmailAccountRegistry(
    Object.entries(ready).map(([id, ok]) => fakeAdapter(id, ok)) as never
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.adapterDefault = undefined;
});

describe('email-account-provider saved seam default', () => {
  it('keeps the policy order (gmail → outlook) with no saved default', async () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', '');
    expect((await registry({ gmail: true, outlook: true }).resolve()).id).toBe('gmail');
    expect((await registry({ gmail: false, outlook: true }).resolve()).id).toBe('outlook');
  });

  it('prefers the saved default when nothing explicit is given', async () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'email-account-provider=outlook');
    expect((await registry({ gmail: true, outlook: true }).resolve()).id).toBe('outlook');
  });

  it('an explicit account and the adapter default still win', async () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'email-account-provider=outlook');
    expect((await registry({ gmail: true, outlook: true }).resolve('gmail')).id).toBe('gmail');
    mocks.adapterDefault = 'gmail';
    expect((await registry({ gmail: true, outlook: true }).resolve()).id).toBe('gmail');
  });

  it('an unready saved default falls through to the next ready account', async () => {
    vi.stubEnv('KYBERION_SEAM_DEFAULTS', 'email-account-provider=outlook');
    expect((await registry({ gmail: true, outlook: false }).resolve()).id).toBe('gmail');
  });
});
