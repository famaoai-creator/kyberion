import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  loopback: true,
  mutationDenied: false,
  viewer: { role: 'localadmin', principalId: 'human:owner' } as Record<string, unknown> | null,
  viewerStatus: 401,
}));
vi.mock('./loopback-peer', () => ({ isLoopbackPeer: () => state.loopback }));
vi.mock('./api-guard', () => ({
  requireConciergeMutationAccess: () =>
    state.mutationDenied ? new Response('', { status: 403 }) : null,
}));
vi.mock('./viewer-context', () => ({
  resolveConciergeViewer: () =>
    state.viewer
      ? { context: state.viewer }
      : { response: new Response('', { status: state.viewerStatus }) },
}));

import { isLocalEngineConfigHost, resolveEngineConfigOperator } from './engine-config-access';

const req = (host: string | null = '127.0.0.1:3050') =>
  ({ headers: new Headers(host ? { host } : {}) }) as unknown as NextRequest;

describe('isLocalEngineConfigHost', () => {
  it('accepts only bare loopback authorities', () => {
    for (const host of ['localhost:3050', '127.0.0.1:3050', '[::1]:3050', 'localhost'])
      expect(isLocalEngineConfigHost(host)).toBe(true);
    for (const host of [
      null,
      '',
      'kyberion.example.com',
      '192.168.1.5:3050',
      'user@localhost',
      'localhost/x',
    ])
      expect(isLocalEngineConfigHost(host)).toBe(false);
  });
});

describe('resolveEngineConfigOperator', () => {
  beforeEach(() => {
    state.loopback = true;
    state.mutationDenied = false;
    state.viewer = { role: 'localadmin', principalId: 'human:owner' };
    state.viewerStatus = 401;
  });

  it('gives a local localadmin a loopback operator principal', () => {
    expect(resolveEngineConfigOperator(req(), true).principal).toEqual({
      role: 'localadmin',
      source: 'loopback',
      principalId: 'human:owner',
      loopback: true,
    });
  });

  it('refuses a remote peer or a non-loopback Host before resolving anyone', () => {
    state.loopback = false;
    expect(resolveEngineConfigOperator(req(), false)).toMatchObject({ status: 403 });
    state.loopback = true;
    expect(resolveEngineConfigOperator(req('kyberion.example.com'), false)).toMatchObject({
      status: 403,
    });
  });

  it('refuses a cross-origin write and a non-admin viewer', () => {
    state.mutationDenied = true;
    const denied = resolveEngineConfigOperator(req(), true);
    expect(denied.principal).toBeUndefined();
    // The mutation guard's own answer (403 here; 429 / 401 alike) passes through.
    expect(denied.response?.status).toBe(403);
    expect(resolveEngineConfigOperator(req(), false).principal).toBeDefined();
    state.mutationDenied = false;
    state.viewer = { role: 'readonly', principalId: 'human:viewer' };
    expect(resolveEngineConfigOperator(req(), false)).toMatchObject({
      denial: 'engine_config_local_session_required',
    });
  });

  it('asks a signed-out local visitor to authenticate', () => {
    state.viewer = null;
    expect(resolveEngineConfigOperator(req(), false)).toMatchObject({
      status: 401,
      denial: 'engine_config_authentication_required',
    });
  });
});
