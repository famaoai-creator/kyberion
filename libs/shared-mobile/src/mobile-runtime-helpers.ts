/**
 * Shared helpers for the iOS and Android actuator runtime pipelines.
 * Platform-specific behavior stays in each actuator's runtime-helpers; only
 * contract-level primitives that both platforms implement identically (or
 * parameterized by `platform`) live here.
 */
import * as path from 'node:path';
import { safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { assertValidMobileAppProfile } from '@agent/core/mobile-profile-validators';
import type { MobileAppProfile } from '@agent/core/types';

export type MobilePlatform = 'android' | 'ios';

export function ensureParentDir(targetPath: string): void {
  const dir = path.dirname(targetPath);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
}

export function safeOrigin(targetUrl: string): string {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return '';
  }
}

export function resolveObjectRef(key: unknown, ctx: Record<string, unknown>): unknown {
  if (!key || typeof key !== 'string') return undefined;
  return ctx[key];
}

export function resolveAppProfile(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>
): MobileAppProfile | undefined {
  if (params.app_profile && typeof params.app_profile === 'object') {
    assertValidMobileAppProfile(params.app_profile, 'params.app_profile');
    return params.app_profile as MobileAppProfile;
  }
  if (params.profile && typeof params.profile === 'object') {
    assertValidMobileAppProfile(params.profile, 'params.profile');
    return params.profile as MobileAppProfile;
  }
  if (typeof params.app_profile_from === 'string' && ctx[params.app_profile_from]) {
    assertValidMobileAppProfile(ctx[params.app_profile_from], `ctx.${params.app_profile_from}`);
    return ctx[params.app_profile_from] as MobileAppProfile;
  }
  if (typeof params.profile_from === 'string' && ctx[params.profile_from]) {
    assertValidMobileAppProfile(ctx[params.profile_from], `ctx.${params.profile_from}`);
    return ctx[params.profile_from] as MobileAppProfile;
  }
  if (ctx.app_profile) {
    assertValidMobileAppProfile(ctx.app_profile, 'ctx.app_profile');
    return ctx.app_profile as MobileAppProfile;
  }
  return undefined;
}

export function buildSessionHandoffArtifact(
  params: Record<string, unknown>,
  ctx: Record<string, unknown>,
  resolve: (val: unknown) => unknown,
  platform: MobilePlatform
) {
  const profile = resolveAppProfile(params, ctx);
  const targetUrl = String(
    resolve(
      params.target_url ||
        profile?.webview?.session_handoff?.target_url ||
        profile?.webview?.entry_url ||
        ''
    )
  ).trim();
  if (!targetUrl)
    throw new Error(
      'emit_session_handoff requires params.target_url or app_profile.webview.session_handoff.target_url'
    );

  const localStorage =
    resolveObjectRef(params.local_storage_from, ctx) || resolve(params.local_storage) || {};
  const sessionStorage =
    resolveObjectRef(params.session_storage_from, ctx) || resolve(params.session_storage) || {};
  const headers = resolveObjectRef(params.headers_from, ctx) || resolve(params.headers) || {};
  const cookies = resolveObjectRef(params.cookies_from, ctx) || resolve(params.cookies) || [];

  return {
    kind: 'webview-session-handoff',
    target_url: targetUrl,
    origin: safeOrigin(targetUrl),
    browser_session_id: String(
      resolve(
        params.browser_session_id ||
          profile?.webview?.session_handoff?.browser_session_id ||
          `${platform}-webview`
      )
    ),
    prefer_persistent_context:
      params.prefer_persistent_context ??
      profile?.webview?.session_handoff?.prefer_persistent_context ??
      true,
    cookies,
    local_storage: localStorage,
    session_storage: sessionStorage,
    headers,
    source: {
      platform,
      app_id: profile?.app_id || ctx.app_id || `${platform}-app`,
    },
  };
}
