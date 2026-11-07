import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const core = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  access: {
    principal: { role: 'localadmin', source: 'loopback', principalId: 'h', loopback: true },
  } as Record<string, unknown>,
}));
vi.mock('@agent/shared-voice/engine-runtime-preferences-operator', () => {
  class EngineRuntimeOperatorError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    EngineRuntimeOperatorError,
    getOperatorEngineRuntimePreferences: core.get,
    updateOperatorEngineRuntimePreferences: core.update,
  };
});
vi.mock('../../../../lib/engine-config-access', () => ({
  resolveEngineConfigOperator: () => core.access,
}));

import { EngineRuntimeOperatorError } from '@agent/shared-voice/engine-runtime-preferences-operator';
import { GET, POST } from './route.js';

const post = (body: unknown) =>
  ({ headers: new Headers(), json: async () => body }) as unknown as NextRequest;
const get = () => ({ headers: new Headers() }) as unknown as NextRequest;
const snapshot = {
  preferences: {},
  profile: { kind: 'personal', id: 'personal' },
  revision: 'a'.repeat(64),
};

describe('/api/voice/engine-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    core.access = {
      principal: { role: 'localadmin', source: 'loopback', principalId: 'h', loopback: true },
    };
    core.get.mockReturnValue(snapshot);
    core.update.mockReturnValue(snapshot);
  });

  it('returns the snapshot to the local operator', async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, revision: snapshot.revision });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses everyone else with the denial code and never reads', async () => {
    core.access = { denial: 'engine_config_local_session_required', status: 403 };
    const res = await GET(get());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('engine_config_local_session_required');
    expect(core.get).not.toHaveBeenCalled();
    expect((await POST(post({ expected_revision: 'x' }))).status).toBe(403);
    expect(core.update).not.toHaveBeenCalled();
  });

  it('passes a mutation-guard answer through unchanged', async () => {
    core.access = { response: new Response('slow down', { status: 429 }) };
    expect((await POST(post({ expected_revision: 'a' }))).status).toBe(429);
    expect(core.update).not.toHaveBeenCalled();
  });

  it('answers a core operator refusal with 403, not 500', async () => {
    core.get.mockImplementationOnce(() => {
      throw new Error('[ENGINE_RUNTIME_OPERATOR_DENIED]');
    });
    const res = await GET(get());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('engine_config_local_session_required');
  });

  it('maps operator errors to 400 / 409 and hides anything else', async () => {
    expect((await POST(post([]))).status).toBe(400);
    core.update.mockImplementationOnce(() => {
      throw new (EngineRuntimeOperatorError as unknown as new (c: string) => Error)(
        'engine_config_conflict'
      );
    });
    expect((await POST(post({ expected_revision: 'a' }))).status).toBe(409);
    core.update.mockImplementationOnce(() => {
      throw new (EngineRuntimeOperatorError as unknown as new (c: string) => Error)(
        'invalid_patch'
      );
    });
    expect((await POST(post({ expected_revision: 'a' }))).status).toBe(400);
    core.update.mockImplementationOnce(() => {
      throw new Error('/Users/x/knowledge/personal/onboarding/engine-runtime.json EACCES');
    });
    const res = await POST(post({ expected_revision: 'a' }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('/Users/x');
  });
});
