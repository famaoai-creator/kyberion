import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import {
  buildSessionHandoffArtifact,
  ensureParentDir,
  resolveAppProfile,
  resolveObjectRef,
  safeOrigin,
} from './mobile-runtime-helpers.js';

vi.mock('@agent/core/secure-io', () => ({ safeExistsSync: vi.fn(), safeMkdir: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const profile = {
  app_id: 'example',
  platform: 'android' as const,
  package_name: 'example.app',
  selectors: {},
};
const resolve = (value: unknown) => value;

describe('mobile runtime helpers', () => {
  it('creates only a missing parent through secure I/O', () => {
    const target = path.join('scratch', 'image.png');
    vi.mocked(safeExistsSync).mockReturnValue(false);
    ensureParentDir(target);
    expect(safeExistsSync).toHaveBeenCalledWith(path.dirname(target));
    expect(safeMkdir).toHaveBeenCalledExactlyOnceWith(path.dirname(target), { recursive: true });
    vi.mocked(safeMkdir).mockClear();
    vi.mocked(safeExistsSync).mockReturnValue(true);
    ensureParentDir(target);
    expect(safeMkdir).not.toHaveBeenCalled();
  });

  it('extracts origins and tolerates malformed URLs', () => {
    expect(safeOrigin('https://example.com:8443/path')).toBe('https://example.com:8443');
    expect(safeOrigin('not a URL')).toBe('');
  });

  it('resolves only nonempty string references without copying values', () => {
    const value = { token: 'fixture' };
    expect(resolveObjectRef('saved', { saved: value })).toBe(value);
    for (const key of [undefined, null, '', 42, {}]) {
      expect(resolveObjectRef(key, {})).toBeUndefined();
    }
    expect(resolveObjectRef('missing', {})).toBeUndefined();
  });

  it('resolves profiles in the documented precedence order', () => {
    const profiles = Array.from({ length: 5 }, (_, index) => ({
      ...profile,
      app_id: `app-${index}`,
    }));
    const params: Record<string, unknown> = {
      app_profile: profiles[0],
      profile: profiles[1],
      app_profile_from: 'a',
      profile_from: 'b',
    };
    const ctx = { a: profiles[2], b: profiles[3], app_profile: profiles[4] };
    for (const key of ['app_profile', 'profile', 'app_profile_from', 'profile_from']) {
      expect(resolveAppProfile(params, ctx)).toBe(profiles.shift());
      delete params[key];
    }
    expect(resolveAppProfile(params, ctx)).toBe(ctx.app_profile);
    expect(resolveAppProfile({}, {})).toBeUndefined();
  });

  it.each([
    [{ app_profile: {} }, {}, 'params.app_profile'],
    [{ profile: {} }, {}, 'params.profile'],
    [{ app_profile_from: 'saved' }, { saved: {} }, 'ctx.saved'],
    [{ profile_from: 'saved' }, { saved: {} }, 'ctx.saved'],
    [{}, { app_profile: {} }, 'ctx.app_profile'],
  ])('rejects invalid profiles at their original source', (params, ctx, source) => {
    expect(() => resolveAppProfile(params, ctx)).toThrow(`Invalid mobile app profile at ${source}`);
  });

  it.each(['android', 'ios'] as const)('builds platform defaults for %s', (platform) => {
    expect(
      buildSessionHandoffArtifact(
        { target_url: ' https://example.com/path ' },
        {},
        resolve,
        platform
      )
    ).toEqual({
      kind: 'webview-session-handoff',
      target_url: 'https://example.com/path',
      origin: 'https://example.com',
      browser_session_id: `${platform}-webview`,
      prefer_persistent_context: true,
      cookies: [],
      local_storage: {},
      session_storage: {},
      headers: {},
      source: { platform, app_id: `${platform}-app` },
    });
  });

  it('prefers explicit values and context references while preserving false', () => {
    const cookies = [{ name: 'fixture' }];
    const storage = { fixture: 'value' };
    const result = buildSessionHandoffArtifact(
      {
        app_profile: profile,
        target_url: 'https://explicit.example',
        browser_session_id: 'explicit',
        prefer_persistent_context: false,
        cookies_from: 'cookies',
        cookies: ['ignored'],
        local_storage_from: 'storage',
        session_storage: storage,
        headers: storage,
      },
      { cookies, storage, app_id: 'ignored' },
      resolve,
      'android'
    );
    expect(result.cookies).toBe(cookies);
    expect(result.local_storage).toBe(storage);
    expect(result.session_storage).toBe(storage);
    expect(result.headers).toBe(storage);
    expect(result.browser_session_id).toBe('explicit');
    expect(result.prefer_persistent_context).toBe(false);
    expect(result.source.app_id).toBe(profile.app_id);
  });

  it('resolves dynamic values but keeps context references intact', () => {
    const referencedCookies = [{ name: 'fixture' }];
    const storage = { fixture: 'resolved' };
    const values: Record<string, unknown> = {
      target: 'not a URL',
      session: 'resolved-session',
      local: storage,
      sessionStorage: storage,
      headers: storage,
    };
    const resolver = vi.fn((value: unknown) => (typeof value === 'string' ? values[value] : value));
    const result = buildSessionHandoffArtifact(
      {
        target_url: 'target',
        browser_session_id: 'session',
        local_storage: 'local',
        session_storage: 'sessionStorage',
        headers: 'headers',
        cookies_from: 'saved',
        cookies: 'ignored',
      },
      { saved: referencedCookies, app_id: 'context-app' },
      resolver,
      'ios'
    );
    expect(result.target_url).toBe('not a URL');
    expect(result.origin).toBe('');
    expect(result.browser_session_id).toBe('resolved-session');
    expect(result.local_storage).toBe(storage);
    expect(result.session_storage).toBe(storage);
    expect(result.headers).toBe(storage);
    expect(result.cookies).toBe(referencedCookies);
    expect(result.source.app_id).toBe('context-app');
    expect(resolver.mock.calls.map(([value]) => value)).toEqual([
      'target',
      'local',
      'sessionStorage',
      'headers',
      'session',
    ]);
  });

  it('uses profile handoff settings, then entry URL, and requires a target', () => {
    const webview = {
      entry_url: 'https://entry.example',
      session_handoff: {
        target_url: 'https://handoff.example',
        browser_session_id: 'saved',
        prefer_persistent_context: false,
      },
    };
    const result = buildSessionHandoffArtifact(
      { app_profile: { ...profile, webview } },
      {},
      resolve,
      'ios'
    );
    expect(result.target_url).toBe('https://handoff.example');
    expect(result.browser_session_id).toBe('saved');
    expect(result.prefer_persistent_context).toBe(false);
    expect(
      buildSessionHandoffArtifact(
        { app_profile: { ...profile, webview: { entry_url: webview.entry_url } } },
        {},
        resolve,
        'ios'
      ).target_url
    ).toBe(webview.entry_url);
    expect(() => buildSessionHandoffArtifact({}, {}, resolve, 'ios')).toThrow(
      'emit_session_handoff requires'
    );
  });
});
