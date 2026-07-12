import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHRONOS_LOCALE_EVENT,
  CHRONOS_LOCALE_STORAGE_KEY,
  normalizeChronosLocale,
  readStoredChronosLocale,
  resolveChronosLocale,
  setChronosLocalePreference,
} from './ux-vocabulary';

// UX-03 Task 5: an explicit header-toggle choice persists in localStorage
// and outranks the browser language.

function installWindow(options: { stored?: string | null; language?: string }) {
  const store = new Map<string, string>();
  if (options.stored) store.set(CHRONOS_LOCALE_STORAGE_KEY, options.stored);
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const fakeWindow = {
    navigator: { language: options.language ?? 'en-US' },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
    dispatchEvent: (event: { type: string }) => {
      for (const listener of listeners[event.type] ?? []) listener(event);
      return true;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      (listeners[type] ??= []).push(listener);
    },
  };
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal(
    'CustomEvent',
    class {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
  );
  return { store, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chronos locale persistence (UX-03)', () => {
  it('prefers the stored operator choice over the browser language', () => {
    installWindow({ stored: 'ja', language: 'en-US' });
    expect(resolveChronosLocale()).toBe('ja');
  });

  it('falls back to navigator.language when nothing is stored', () => {
    installWindow({ stored: null, language: 'ja-JP' });
    expect(resolveChronosLocale()).toBe('ja');
  });

  it('ignores garbage stored values', () => {
    installWindow({ stored: 'fr', language: 'en-US' });
    expect(readStoredChronosLocale()).toBeNull();
    expect(resolveChronosLocale()).toBe('en');
  });

  it('setChronosLocalePreference persists and notifies listeners', () => {
    const { store, listeners } = installWindow({ language: 'en-US' });
    const seen: unknown[] = [];
    (listeners[CHRONOS_LOCALE_EVENT] ??= []).push((event) => seen.push(event));

    setChronosLocalePreference('ja');

    expect(store.get(CHRONOS_LOCALE_STORAGE_KEY)).toBe('ja');
    expect(seen).toHaveLength(1);
    expect(resolveChronosLocale()).toBe('ja');
  });

  it('normalizeChronosLocale keeps accepting raw browser tags', () => {
    expect(normalizeChronosLocale('ja_JP')).toBe('ja');
    expect(normalizeChronosLocale('en-GB')).toBe('en');
  });
});
