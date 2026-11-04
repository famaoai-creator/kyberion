import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSurfaceBrowserUrl: vi.fn((_surface: string): string => 'http://127.0.0.1:3050'),
  resolveSurfaceUrl: vi.fn((_surface: string): string => 'http://127.0.0.1:3050'),
}));
vi.mock('@agent/core/surface/surface-url', () => ({
  resolveSurfaceBrowserUrl: mocks.resolveSurfaceBrowserUrl,
  resolveSurfaceUrl: mocks.resolveSurfaceUrl,
}));

import { chronosRedirectTarget, conciergeOriginForRequest, proxy } from './proxy.js';

const CONCIERGE = 'http://127.0.0.1:3050';

describe('Chronos compatibility redirects', () => {
  beforeEach(() => {
    mocks.resolveSurfaceBrowserUrl.mockReset().mockReturnValue(CONCIERGE);
    mocks.resolveSurfaceUrl.mockReset().mockReturnValue(CONCIERGE);
  });

  it.each([
    ['/', '', `${CONCIERGE}/ops`],
    [
      '/',
      '?section=knowledge&tenant_slug=acme',
      `${CONCIERGE}/ops?section=knowledge&tenant_slug=acme`,
    ],
    ['/discussion', '?room=r1', `${CONCIERGE}/ops/discussion?room=r1`],
    ['/login', '?next=%2F', `${CONCIERGE}/ops?next=%2F`],
    ['/api/status', '', `${CONCIERGE}/api/ops/status`],
    ['/api/workitems', '?tenant=acme', `${CONCIERGE}/api/ops/workitems?tenant=acme`],
    ['/api/discussions/abc/stream', '', `${CONCIERGE}/api/ops/discussions/abc/stream`],
  ])('maps %s%s to %s', (pathname, search, expected) => {
    expect(chronosRedirectTarget(pathname, search, CONCIERGE)).toBe(expected);
  });

  it('keeps the health probe local', () => {
    expect(chronosRedirectTarget('/api/healthz', '', CONCIERGE)).toBeNull();
    const response = proxy(new NextRequest('http://127.0.0.1:3000/api/healthz'));
    expect(response.headers.get('location')).toBeNull();
    expect(mocks.resolveSurfaceBrowserUrl).not.toHaveBeenCalled();
  });

  it('issues a 308 to the Concierge origin resolved for the concierge surface', () => {
    const response = proxy(
      new NextRequest('http://127.0.0.1:3000/api/agent?x=1', { method: 'POST' })
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`${CONCIERGE}/api/ops/agent?x=1`);
    expect(mocks.resolveSurfaceBrowserUrl).toHaveBeenCalledWith('concierge');
    const page = proxy(new NextRequest('http://127.0.0.1:3000/?section=diagnostics'));
    expect(page.status).toBe(308);
    expect(page.headers.get('location')).toBe(`${CONCIERGE}/ops?section=diagnostics`);
  });

  it('fails closed (503) when the Concierge URL cannot be resolved', () => {
    mocks.resolveSurfaceBrowserUrl.mockImplementation(() => {
      throw new Error('[SURFACE_URL] Invalid browser surface URL');
    });
    expect(proxy(new NextRequest('http://127.0.0.1:3000/')).status).toBe(503);
  });

  it.each([
    // loopback browser host, no declared public origin → keep the browser's hostname
    ['localhost:3000', CONCIERGE, 'http://localhost:3050'],
    ['LOCALHOST:3000', CONCIERGE, 'http://localhost:3050'],
    ['[::1]:3000', CONCIERGE, 'http://[::1]:3050'],
    ['127.0.0.1:3000', CONCIERGE, CONCIERGE],
    // non-loopback / hostile / missing Host → never derived from the request
    ['evil.example.com', CONCIERGE, CONCIERGE],
    ['localhost.evil.example:3000', CONCIERGE, CONCIERGE],
    ['localhost@evil.example', CONCIERGE, CONCIERGE],
    ['', CONCIERGE, CONCIERGE],
    [null, CONCIERGE, CONCIERGE],
  ])('keeps loopback host %s → %s base → %s', (host, base, expected) => {
    expect(conciergeOriginForRequest(base, base, host)).toBe(expected);
  });

  it('never rewrites a declared public or overridden origin', () => {
    expect(conciergeOriginForRequest('https://ops.example.com', CONCIERGE, 'localhost:3000')).toBe(
      'https://ops.example.com'
    );
    // declared loopback public origin differs from the registry origin → kept verbatim
    expect(conciergeOriginForRequest('http://127.0.0.1:4050', CONCIERGE, 'localhost:3000')).toBe(
      'http://127.0.0.1:4050'
    );
    // urlEnv override pointing at a non-loopback host → kept verbatim
    expect(
      conciergeOriginForRequest('http://10.0.0.5:3050', 'http://10.0.0.5:3050', 'localhost:3000')
    ).toBe('http://10.0.0.5:3050');
  });

  it('redirects a localhost:3000 visit to localhost on the Concierge port', () => {
    const response = proxy(
      new NextRequest('http://localhost:3000/?section=work-items', {
        headers: { host: 'localhost:3000' },
      })
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('http://localhost:3050/ops?section=work-items');
  });
});
