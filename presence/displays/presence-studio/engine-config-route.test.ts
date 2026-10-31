import { beforeEach, describe, it, expect, vi } from 'vitest';
import type express from 'express';
const state = vi.hoisted(() => ({
  source: 'loopback',
  get: vi.fn(),
  update: vi.fn(),
  auth: vi.fn(),
}));
vi.mock('@agent/core/voice/engine-runtime-preferences-operator', () => ({
  getOperatorEngineRuntimePreferences: state.get,
  updateOperatorEngineRuntimePreferences: state.update,
  EngineRuntimeOperatorError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
}));
vi.mock('./security.js', () => ({
  PresenceStudioViewerError: class extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
  isLoopbackAddress: (address: string) =>
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address),
  resolvePresenceStudioViewerContext: () => {
    state.auth();
    return { source: state.source, principalId: 'human:local' };
  },
  requirePresenceStudioLocalAdmin: (viewer: { source: string }) => {
    if (viewer.source !== 'loopback') throw new Error('not local');
  },
}));
import { registerEngineConfigRoute } from './engine-config-route.js';
import { EngineRuntimeOperatorError } from '@agent/core/voice/engine-runtime-preferences-operator';
type Handler = (req: unknown, res: unknown) => unknown;
const handlers = new Map<string, Handler>();
let parserFailure: express.ErrorRequestHandler;
registerEngineConfigRoute({
  use: (_p: string, handler: express.ErrorRequestHandler) => {
    parserFailure = handler;
  },
  get: (_p: string, handler: Handler) => handlers.set('get', handler),
  post: (_p: string, handler: Handler) => handlers.set('post', handler),
} as unknown as express.Express);
function request(method = 'get', options: Record<string, unknown> = {}, error?: unknown) {
  const req = {
    method: method.toUpperCase(),
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:3210', origin: 'http://localhost:3210' },
    body: { patch: { python_bin: '/python' }, expected_revision: 'a'.repeat(64) },
    ...options,
  };
  const result = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    setHeader: (key: string, value: string) => {
      result.headers[key] = value;
    },
    status: (code: number) => {
      result.status = code;
      return res;
    },
    json: (body: unknown) => {
      result.body = body;
      return res;
    },
  };
  if (error !== undefined)
    parserFailure(
      error,
      req as unknown as express.Request,
      res as unknown as express.Response,
      vi.fn()
    );
  else handlers.get(method)!(req, res);
  return result;
}
beforeEach(() => {
  state.source = 'loopback';
  state.get.mockReset().mockReturnValue({
    preferences: { version: '1.0.0' },
    profile: { kind: 'personal', id: 'personal' },
    revision: 'a'.repeat(64),
  });
  state.update.mockReset().mockReturnValue({
    preferences: { version: '1.0.0' },
    profile: { kind: 'personal', id: 'personal' },
    revision: 'b'.repeat(64),
  });
  state.auth.mockClear();
});
describe('private engine config transport', () => {
  it('returns no-store safe snapshots for a local operator', () => {
    const result = request();
    expect(result.status).toBe(200);
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(result.body).toMatchObject({ ok: true, profile: { kind: 'personal' } });
  });
  it('rejects remote peers, DNS rebinding hosts and missing hosts before auth/private I/O', () => {
    for (const options of [
      { socket: { remoteAddress: '10.0.0.4' } },
      { headers: { host: 'evil.example' } },
      { headers: {} },
      { headers: { host: 'localhost:3210/path' } },
    ]) {
      expect(request('get', options).status).toBe(403);
    }
    expect(state.auth).not.toHaveBeenCalled();
    expect(state.get).not.toHaveBeenCalled();
  });
  it('requires actual same origin on POST even with a bearer token', () => {
    for (const headers of [
      { host: 'localhost:3210', authorization: 'Bearer valid' },
      { host: 'localhost:3210', origin: 'http://evil.example' },
      { host: 'localhost:3210', origin: 'https://localhost:3210' },
    ])
      expect(request('post', { headers }).status).toBe(403);
    expect(state.update).not.toHaveBeenCalled();
  });
  it('returns fixed errors without raw paths or exception material', () => {
    state.get.mockImplementation(() => {
      throw new Error('/private/profile secret=value');
    });
    const result = request();
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ ok: false, error: 'engine_config_unavailable' });
    expect(result.headers['Cache-Control']).toBe('no-store');
  });
  it('maps conflict and core validation to safe status codes', () => {
    state.update.mockImplementation(() => {
      throw new EngineRuntimeOperatorError('engine_config_conflict');
    });
    expect(request('post').status).toBe(409);
    state.update.mockImplementation(() => {
      throw new EngineRuntimeOperatorError('preference_rejected');
    });
    expect(request('post').body).toEqual({ ok: false, error: 'preference_rejected' });
  });
  it('rejects non-object bodies and forwards partial patches without adding profile authority', () => {
    expect(request('post', { body: [] }).status).toBe(400);
    expect(state.update).not.toHaveBeenCalled();
    request('post');
    expect(state.update.mock.calls[0][1]).toEqual({
      patch: { python_bin: '/python' },
      expected_revision: 'a'.repeat(64),
    });
  });
  it('closes malformed and oversized parser errors with safe JSON and no-store', () => {
    for (const [type, status] of [
      ['entity.parse.failed', 400],
      ['entity.too.large', 413],
    ] as const) {
      const result = request(
        'post',
        {},
        { type, status, message: '/private/profile secret', body: 'raw-secret', stack: 'raw-stack' }
      );
      expect(result.status).toBe(status);
      expect(result.headers['Cache-Control']).toBe('no-store');
      expect(JSON.stringify(result.body)).not.toMatch(/secret|private|stack/);
    }
    expect(state.get).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });
  it('reauthorizes parser failures before revealing classification or accessing settings', () => {
    const result = request(
      'post',
      { headers: { host: 'localhost:3210', origin: 'http://evil.example' } },
      { type: 'entity.parse.failed', status: 400 }
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ ok: false, error: 'engine_config_local_session_required' });
    expect(state.get).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });
  it('does not expose unexpected parser exceptions or trust a status without a known type', () => {
    for (const error of [
      new Error('secret/path'),
      { type: 'unexpected', status: 400 },
      { type: 'entity.parse.failed', status: 500 },
    ]) {
      const result = request('post', {}, error);
      expect(result.status).toBe(500);
      expect(result.body).toEqual({ ok: false, error: 'engine_config_unavailable' });
    }
  });
});
