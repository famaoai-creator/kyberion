import type { MobileAppProfile, MobileAppProfileIndex, WebAppProfile } from './types.js';
import { safeExistsSync } from './secure-io.js';

export type MobileAppProfileRecord = MobileAppProfileIndex['profiles'][number];
export interface WebAppProfileIndexRecord {
  id: string;
  platform: 'browser';
  title: string;
  path: string;
  description: string;
  tags?: string[];
}

export interface WebAppProfileIndex {
  profiles: WebAppProfileIndexRecord[];
}

export function validateMobileAppProfile(profile: unknown): string[] {
  const errors: string[] = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return ['profile must be an object'];
  }

  const candidate = profile as Record<string, unknown>;

  if (!isNonEmptyString(candidate.app_id)) errors.push('app_id is required');
  if (!isNonEmptyString(candidate.package_name)) errors.push('package_name is required');
  if (!['android', 'ios'].includes(String(candidate.platform || ''))) errors.push('platform must be android or ios');

  if (candidate.launch !== undefined) {
    if (!isPlainObject(candidate.launch)) {
      errors.push('launch must be an object');
    } else {
      const launch = candidate.launch as Record<string, unknown>;
      if (candidate.platform === 'android' && launch.component !== undefined && !isNonEmptyString(launch.component)) {
        errors.push('launch.component must be a non-empty string when provided');
      }
    }
  }

  if (!isPlainObject(candidate.selectors)) {
    errors.push('selectors is required');
    return errors;
  }

  const selectors = candidate.selectors as Record<string, unknown>;
  const loginSelectors = isPlainObject(selectors.login) ? (selectors.login as Record<string, unknown>) : undefined;
  const passkeySelectors = isPlainObject(selectors.passkey) ? (selectors.passkey as Record<string, unknown>) : undefined;

  if (selectors.login !== undefined && !isPlainObject(selectors.login)) {
    errors.push('selectors.login must be an object');
  }
  if (selectors.passkey !== undefined && !isPlainObject(selectors.passkey)) {
    errors.push('selectors.passkey must be an object');
  }

  validateSelector(loginSelectors?.email, 'selectors.login.email', errors);
  validateSelector(loginSelectors?.password, 'selectors.login.password', errors);
  validateSelector(loginSelectors?.submit, 'selectors.login.submit', errors);
  validateSelector(passkeySelectors?.trigger, 'selectors.passkey.trigger', errors);

  if (candidate.webview !== undefined) {
    validateWebview(candidate.webview, 'webview', errors);
  }

  return errors;
}

export function assertValidMobileAppProfile(profile: unknown, source: string): asserts profile is MobileAppProfile {
  const errors = validateMobileAppProfile(profile);
  if (errors.length > 0) {
    throw new Error(`Invalid mobile app profile at ${source}: ${errors.join('; ')}`);
  }
}

export function validateMobileAppProfileIndex(
  index: unknown,
  pathExists: (filePath: string) => boolean = safeExistsSync,
): string[] {
  const errors: string[] = [];
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    return ['index must be an object'];
  }

  const candidate = index as Record<string, unknown>;
  if (!Array.isArray(candidate.profiles)) {
    return ['profiles must be an array'];
  }

  candidate.profiles.forEach((profile, idx) => {
    const label = `profiles[${idx}]`;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      errors.push(`${label} must be an object`);
      return;
    }

    const record = profile as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) errors.push(`${label}.id is required`);
    if (!isNonEmptyString(record.title)) errors.push(`${label}.title is required`);
    if (!isNonEmptyString(record.path)) errors.push(`${label}.path is required`);
    if (!isNonEmptyString(record.description)) errors.push(`${label}.description is required`);
    if (!['android', 'ios'].includes(String(record.platform || ''))) errors.push(`${label}.platform must be android or ios`);
    if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== 'string'))) {
      errors.push(`${label}.tags must be an array of strings`);
    }

    if (isNonEmptyString(record.path) && !pathExists(record.path)) {
      errors.push(`${label}.path does not exist: ${record.path}`);
    }
  });

  return errors;
}

export function assertValidMobileAppProfileIndex(
  index: unknown,
  sourcePath: string,
  pathExists: (filePath: string) => boolean = safeExistsSync,
): asserts index is MobileAppProfileIndex {
  const errors = validateMobileAppProfileIndex(index, pathExists);
  if (errors.length > 0) {
    throw new Error(`Invalid mobile app profile index at ${sourcePath}: ${errors.join('; ')}`);
  }
}

export function validateWebAppProfile(profile: unknown): string[] {
  const errors: string[] = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return ['profile must be an object'];
  }

  const candidate = profile as Record<string, unknown>;
  if (!isNonEmptyString(candidate.app_id)) errors.push('app_id is required');
  if (!isNonEmptyString(candidate.title)) errors.push('title is required');
  if (!isNonEmptyString(candidate.base_url)) errors.push('base_url is required');
  if (candidate.login_route !== undefined && !isNonEmptyString(candidate.login_route)) {
    errors.push('login_route must be a non-empty string when provided');
  }
  if (candidate.logout_route !== undefined && !isNonEmptyString(candidate.logout_route)) {
    errors.push('logout_route must be a non-empty string when provided');
  }
  if (
    candidate.guarded_routes !== undefined &&
    (!Array.isArray(candidate.guarded_routes) || candidate.guarded_routes.some((route) => typeof route !== 'string'))
  ) {
    errors.push('guarded_routes must be an array of strings');
  }

  if (candidate.selectors !== undefined && !isPlainObject(candidate.selectors)) {
    errors.push('selectors must be an object');
  }

  if (candidate.session_handoff !== undefined) {
    validateSessionHandoff(candidate.session_handoff, 'session_handoff', errors);
  }

  if (candidate.debug_routes !== undefined) {
    if (!isPlainObject(candidate.debug_routes)) {
      errors.push('debug_routes must be an object');
    } else {
      const debugRoutes = candidate.debug_routes as Record<string, unknown>;
      if (debugRoutes.session_export !== undefined && !isNonEmptyString(debugRoutes.session_export)) {
        errors.push('debug_routes.session_export must be a non-empty string when provided');
      }
    }
  }

  return errors;
}

export function assertValidWebAppProfile(profile: unknown, source: string): asserts profile is WebAppProfile {
  const errors = validateWebAppProfile(profile);
  if (errors.length > 0) {
    throw new Error(`Invalid web app profile at ${source}: ${errors.join('; ')}`);
  }
}

export function validateWebAppProfileIndex(
  index: unknown,
  pathExists: (filePath: string) => boolean = safeExistsSync,
): string[] {
  const errors: string[] = [];
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    return ['index must be an object'];
  }

  const candidate = index as Record<string, unknown>;
  if (!Array.isArray(candidate.profiles)) {
    return ['profiles must be an array'];
  }

  candidate.profiles.forEach((profile, idx) => {
    const label = `profiles[${idx}]`;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      errors.push(`${label} must be an object`);
      return;
    }

    const record = profile as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) errors.push(`${label}.id is required`);
    if (!isNonEmptyString(record.title)) errors.push(`${label}.title is required`);
    if (!isNonEmptyString(record.path)) errors.push(`${label}.path is required`);
    if (!isNonEmptyString(record.description)) errors.push(`${label}.description is required`);
    if (record.platform !== 'browser') errors.push(`${label}.platform must be browser`);
    if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== 'string'))) {
      errors.push(`${label}.tags must be an array of strings`);
    }
    if (isNonEmptyString(record.path) && !pathExists(record.path)) {
      errors.push(`${label}.path does not exist: ${record.path}`);
    }
  });

  return errors;
}

export function assertValidWebAppProfileIndex(
  index: unknown,
  sourcePath: string,
  pathExists: (filePath: string) => boolean = safeExistsSync,
): asserts index is WebAppProfileIndex {
  const errors = validateWebAppProfileIndex(index, pathExists);
  if (errors.length > 0) {
    throw new Error(`Invalid web app profile index at ${sourcePath}: ${errors.join('; ')}`);
  }
}

function validateSelector(selector: unknown, label: string, errors: string[]): void {
  if (selector === undefined) return;
  if (!isPlainObject(selector)) {
    errors.push(`${label} must be an object`);
    return;
  }

  const candidate = selector as Record<string, unknown>;
  const hasAnySelectorField = ['text', 'resource_id', 'class_name', 'package_name'].some((key) => isNonEmptyString(candidate[key]));
  if (!hasAnySelectorField) {
    errors.push(`${label} must include at least one selector field`);
  }

  for (const key of ['text', 'resource_id', 'class_name', 'package_name']) {
    if (candidate[key] !== undefined && typeof candidate[key] !== 'string') {
      errors.push(`${label}.${key} must be a string`);
    }
  }
}

function validateWebview(webview: unknown, label: string, errors: string[]): void {
  if (!isPlainObject(webview)) {
    errors.push(`${label} must be an object`);
    return;
  }

  const candidate = webview as Record<string, unknown>;
  if (candidate.entry_url !== undefined && typeof candidate.entry_url !== 'string') {
    errors.push(`${label}.entry_url must be a string`);
  }
  if (
    candidate.allowed_origins !== undefined &&
    (!Array.isArray(candidate.allowed_origins) || candidate.allowed_origins.some((origin) => typeof origin !== 'string'))
  ) {
    errors.push(`${label}.allowed_origins must be an array of strings`);
  }
  if (candidate.session_handoff !== undefined) {
    validateSessionHandoff(candidate.session_handoff, `${label}.session_handoff`, errors);
  }
  if (candidate.runtime_export !== undefined) {
    validateRuntimeExport(candidate.runtime_export, `${label}.runtime_export`, errors);
  }
}

function validateSessionHandoff(sessionHandoff: unknown, label: string, errors: string[]): void {
  if (!isPlainObject(sessionHandoff)) {
    errors.push(`${label} must be an object`);
    return;
  }

  const candidate = sessionHandoff as Record<string, unknown>;
  if (candidate.target_url !== undefined && typeof candidate.target_url !== 'string') {
    errors.push(`${label}.target_url must be a string`);
  }
  if (candidate.browser_session_id !== undefined && typeof candidate.browser_session_id !== 'string') {
    errors.push(`${label}.browser_session_id must be a string`);
  }
  if (candidate.prefer_persistent_context !== undefined && typeof candidate.prefer_persistent_context !== 'boolean') {
    errors.push(`${label}.prefer_persistent_context must be a boolean`);
  }
}

function validateRuntimeExport(runtimeExport: unknown, label: string, errors: string[]): void {
  if (!isPlainObject(runtimeExport)) {
    errors.push(`${label} must be an object`);
    return;
  }

  const candidate = runtimeExport as Record<string, unknown>;
  if (candidate.format !== undefined && candidate.format !== 'json') {
    errors.push(`${label}.format must be json when provided`);
  }
  if (candidate.android_device_path !== undefined && typeof candidate.android_device_path !== 'string') {
    errors.push(`${label}.android_device_path must be a string`);
  }
  if (candidate.ios_container_relative_path !== undefined && typeof candidate.ios_container_relative_path !== 'string') {
    errors.push(`${label}.ios_container_relative_path must be a string`);
  }
}

function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
