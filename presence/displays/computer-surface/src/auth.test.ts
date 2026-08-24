import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertComputerSurfacePayloadInScope,
  isComputerSurfaceLoopbackRequest,
  resolveComputerSurfaceViewerContext,
} from '../auth.js';

function request(input: {
  remoteAddress: string;
  authorization?: string;
  forwarded?: string;
}): Parameters<typeof resolveComputerSurfaceViewerContext>[0] {
  return {
    socket: { remoteAddress: input.remoteAddress } as any,
    headers: {
      ...(input.authorization ? { authorization: input.authorization } : {}),
      ...(input.forwarded ? { 'x-forwarded-for': input.forwarded } : {}),
    },
  };
}

describe('Computer Surface viewer context', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves loopback as localadmin while preserving server tenant scope', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    vi.stubEnv('KYBERION_COMPUTER_SURFACE_PRINCIPAL', 'human:operator-a');

    expect(resolveComputerSurfaceViewerContext(request({ remoteAddress: '127.0.0.1' }))).toEqual(
      expect.objectContaining({
        role: 'localadmin',
        source: 'loopback',
        principalId: 'human:operator-a',
        tenantSlugs: ['tenant-a'],
      })
    );
  });

  it('resolves the API token as readonly and excludes personal tier', () => {
    vi.stubEnv('KYBERION_API_TOKEN', 'api-token');
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');

    expect(
      resolveComputerSurfaceViewerContext(
        request({ remoteAddress: '10.0.0.5', authorization: 'Bearer api-token' })
      )
    ).toEqual(
      expect.objectContaining({
        role: 'readonly',
        source: 'token',
        tenantSlugs: ['tenant-a'],
        tierAccess: ['confidential', 'public'],
      })
    );
  });

  it('requires server tenant binding for remote bearer access', () => {
    vi.stubEnv('KYBERION_API_TOKEN', 'api-token');

    expect(() =>
      resolveComputerSurfaceViewerContext(
        request({ remoteAddress: '10.0.0.5', authorization: 'Bearer api-token' })
      )
    ).toThrow('KYBERION_TENANT');
  });

  it('fails closed for unknown tokens and forwarded non-loopback requests', () => {
    vi.stubEnv('KYBERION_LOCALADMIN_TOKEN', 'local-token');
    expect(() =>
      resolveComputerSurfaceViewerContext(
        request({ remoteAddress: '127.0.0.1', authorization: 'Bearer wrong-token' })
      )
    ).toThrow('Unknown Computer Surface viewer token');

    expect(
      isComputerSurfaceLoopbackRequest(
        request({ remoteAddress: '127.0.0.1', forwarded: '10.0.0.5' })
      )
    ).toBe(false);
  });

  it('rejects tenant widening in nested A2UI metadata', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    vi.stubEnv('KYBERION_API_TOKEN', 'api-token');
    const context = resolveComputerSurfaceViewerContext(
      request({ remoteAddress: '10.0.0.5', authorization: 'Bearer api-token' })
    );

    expect(() =>
      assertComputerSurfacePayloadInScope(context, {
        updateDataModel: {
          data: { metadata: { scope: { tenant_slug: 'tenant-b' } } },
        },
      })
    ).toThrow('tenant-b');
  });
});
