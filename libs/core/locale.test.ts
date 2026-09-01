import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import * as core from './core.js';
import {
  _resetLocaleModuleStateForTests,
  normalizeLocale,
  nextSupportedLocale,
  resolveDefaultLocale,
  resolveLocale,
} from './locale.js';

const testRoot = pathResolver.sharedTmp('locale-test');

function fixturePath(name: string): string {
  return `${testRoot}/${name}`;
}

function writeIdentityFixture(name: string, content: unknown): string {
  if (!safeExistsSync(testRoot)) safeMkdir(testRoot, { recursive: true });
  const p = fixturePath(name);
  safeWriteFile(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
}

const ENV_KEYS = ['KYBERION_LOCALE', 'KYBERION_UI_LOCALE', 'LANG'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  clearEnv();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
  }
  _resetLocaleModuleStateForTests();
  if (safeExistsSync(testRoot)) safeRmSync(testRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('nextSupportedLocale', () => {
  it('wraps through the generated locale list', () => {
    expect(nextSupportedLocale('en')).toBe('ja');
    expect(nextSupportedLocale('qps-ploc')).toBe('en');
  });
});

const missingIdentityPath = () => fixturePath('does-not-exist.json');

describe('normalizeLocale', () => {
  it('normalizes ja variants', () => {
    expect(normalizeLocale('ja')).toBe('ja');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('ja_JP')).toBe('ja');
    expect(normalizeLocale('JA')).toBe('ja');
  });

  it('normalizes en variants', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('EN_GB')).toBe('en');
  });

  it('returns null for unknown, empty, and POSIX "no locale" sentinels', () => {
    expect(normalizeLocale('')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale('fr')).toBeNull();
    expect(normalizeLocale('C')).toBeNull();
    expect(normalizeLocale('POSIX')).toBeNull();
    expect(normalizeLocale('c')).toBeNull();
  });
});

describe('resolveDefaultLocale', () => {
  it('reads default_locale from the catalog (currently en)', () => {
    expect(resolveDefaultLocale()).toBe('en');
  });
});

describe('resolveLocale precedence chain', () => {
  beforeEach(() => {
    clearEnv();
  });

  it('step 1: explicit wins over everything else', () => {
    process.env.KYBERION_LOCALE = 'en';
    expect(
      resolveLocale({
        explicit: 'ja',
        surfacePreference: 'en',
        identityPath: missingIdentityPath(),
      })
    ).toBe('ja');
  });

  it('step 2: surfacePreference wins when explicit is absent', () => {
    process.env.KYBERION_LOCALE = 'en';
    expect(
      resolveLocale({
        surfacePreference: 'ja',
        identityPath: missingIdentityPath(),
      })
    ).toBe('ja');
  });

  it('step 3: onboarding identity language wins over env when no explicit/surface value', () => {
    const identityPath = writeIdentityFixture('identity-ja.json', { language: 'ja' });
    process.env.KYBERION_LOCALE = 'en';
    expect(resolveLocale({ identityPath })).toBe('ja');
  });

  it('step 3: identity language also matches the free-text "日本語" answer', () => {
    const identityPath = writeIdentityFixture('identity-nihongo.json', { language: '日本語' });
    expect(resolveLocale({ identityPath })).toBe('ja');
  });

  it('step 3: an identity file with no usable language falls through', () => {
    const identityPath = writeIdentityFixture('identity-empty.json', { name: 'test' });
    process.env.KYBERION_LOCALE = 'en';
    expect(resolveLocale({ identityPath })).toBe('en');
  });

  it('step 4: KYBERION_LOCALE wins when identity has no language', () => {
    process.env.KYBERION_LOCALE = 'ja';
    expect(resolveLocale({ identityPath: missingIdentityPath() })).toBe('ja');
  });

  it('step 4: deprecated KYBERION_UI_LOCALE alias is honored after KYBERION_LOCALE, with a one-time warning', () => {
    process.env.KYBERION_UI_LOCALE = 'ja';
    const warnSpy = vi.spyOn(core.logger, 'warn');
    expect(resolveLocale({ identityPath: missingIdentityPath() })).toBe('ja');
    expect(resolveLocale({ identityPath: missingIdentityPath() })).toBe('ja');
    const aliasWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes('KYBERION_UI_LOCALE')
    );
    expect(aliasWarnings.length).toBe(1);
  });

  it('step 5: LANG is consulted after both env vars are absent', () => {
    process.env.LANG = 'ja_JP.UTF-8';
    expect(resolveLocale({ identityPath: missingIdentityPath() })).toBe('ja');
  });

  it('step 5: navigatorLanguage is consulted when supplied and LANG is unset/unusable', () => {
    process.env.LANG = 'C';
    expect(resolveLocale({ identityPath: missingIdentityPath(), navigatorLanguage: 'ja-JP' })).toBe(
      'ja'
    );
  });

  it('step 6: falls back to the catalog default_locale when nothing else resolves', () => {
    process.env.LANG = 'C';
    expect(resolveLocale({ identityPath: missingIdentityPath() })).toBe('en');
  });

  // Behavior-change pins (I18N-01): the old resolveOperatorLocale() hardcoded
  // 'ja' fallback is gone. These pin the two cases called out in the plan.
  it('behavior change: identity-absent + LANG=ja_JP.UTF-8 resolves to ja', () => {
    process.env.LANG = 'ja_JP.UTF-8';
    expect(resolveLocale({ identityPath: missingIdentityPath() })).toBe('ja');
  });

  it('behavior change: identity-absent + LANG=C resolves to en (not the old hardcoded ja)', () => {
    process.env.LANG = 'C';
    expect(resolveLocale({ identityPath: missingIdentityPath() })).toBe('en');
  });

  it('ignores an identity file reached through a symlink', () => {
    const targetPath = writeIdentityFixture('identity-outside.json', { language: 'ja' });
    const linkedPath = fixturePath('identity-linked.json');
    safeSymlinkSync(targetPath, linkedPath);
    process.env.LANG = 'C';
    expect(resolveLocale({ identityPath: linkedPath })).toBe('en');
  });
});
