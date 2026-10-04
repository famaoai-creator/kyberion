import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('./surface-runtime.js', () => ({
  loadSurfaceManifest: () => ({
    surfaces: [
      { id: 'concierge', port: 3050 },
      { id: 'presence-studio', port: 3031, urlEnv: 'PRESENCE_STUDIO_URL' },
      { id: 'computer-surface', port: 3040 },
    ],
  }),
}));
import { resolveSurfaceBrowserUrl, resolveSurfaceUrl } from './surface-url.js';
beforeEach(() => {
  vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URLS', '');
  vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URL', '');
  vi.stubEnv('PRESENCE_STUDIO_URL', '');
});
afterEach(() => vi.unstubAllEnvs());
describe('browser surface origins', () => {
  it('keeps manifest loopback defaults without changing runtime service URLs', () => {
    expect(resolveSurfaceBrowserUrl('concierge')).toBe('http://127.0.0.1:3050');
    expect(resolveSurfaceBrowserUrl('computer-surface')).toBe('http://127.0.0.1:3040');
  });
  it('uses existing per-surface public origins without routing runtime calls through the proxy', () => {
    vi.stubEnv(
      'KYBERION_OIDC_PUBLIC_BASE_URLS',
      'concierge=https://desk.example.test,computer-surface=https://screen.example.test'
    );
    expect(resolveSurfaceBrowserUrl('concierge')).toBe('https://desk.example.test');
    expect(resolveSurfaceBrowserUrl('computer-surface')).toBe('https://screen.example.test');
    expect(resolveSurfaceUrl('concierge')).toBe('http://127.0.0.1:3050');
  });
  it('uses the declared common origin and gives named origins precedence', () => {
    vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URL', 'https://all.example.test');
    vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URLS', 'concierge=https://desk.example.test');
    expect(resolveSurfaceBrowserUrl('presence-studio')).toBe('https://all.example.test');
    expect(resolveSurfaceBrowserUrl('concierge')).toBe('https://desk.example.test');
  });
  it('preserves existing surface URL path bases when no public origin is declared', () => {
    vi.stubEnv('PRESENCE_STUDIO_URL', 'https://presence.example.test/surface/');
    expect(resolveSurfaceBrowserUrl('presence-studio')).toBe(
      'https://presence.example.test/surface'
    );
  });
  it.each([
    'javascript:alert(1)',
    'https://user:password@example.test',
    'http://remote.example.test',
  ])('rejects unsafe public origin %s', (value) => {
    vi.stubEnv('KYBERION_OIDC_PUBLIC_BASE_URL', value);
    expect(() => resolveSurfaceBrowserUrl('concierge')).toThrow('Invalid public surface origin');
  });
});
