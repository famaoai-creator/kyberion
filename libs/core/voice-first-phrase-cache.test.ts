import { afterEach, describe, expect, it } from 'vitest';
import {
  FirstPhraseCache,
  fingerprintVoiceSettings,
  type FirstPhraseCacheKey,
} from './voice-first-phrase-cache.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

const TEST_ID = `voice-first-phrase-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const TEST_DIR = pathResolver.sharedTmp(TEST_ID);
const SOURCE_DIR = pathResolver.sharedTmp(`${TEST_ID}-src`);

afterEach(() => {
  if (safeExistsSync(TEST_DIR)) safeRmSync(TEST_DIR, { recursive: true, force: true });
  if (safeExistsSync(SOURCE_DIR)) safeRmSync(SOURCE_DIR, { recursive: true, force: true });
});

function writeSourceAudio(name: string, contents = 'audio-bytes'): string {
  safeMkdir(SOURCE_DIR);
  const filePath = pathResolver.sharedTmp(`${TEST_ID}-src/${name}`);
  safeWriteFile(filePath, contents);
  return filePath;
}

function baseKey(overrides: Partial<FirstPhraseCacheKey> = {}): FirstPhraseCacheKey {
  return {
    engine: 'kokoro',
    voiceId: 'voice-a',
    voiceRevision: 'rev-1',
    settingsFingerprint: fingerprintVoiceSettings({ speed: 1.0 }),
    text: 'こんにちは',
    ...overrides,
  };
}

describe('fingerprintVoiceSettings', () => {
  it('produces the same hash regardless of key order', () => {
    const a = fingerprintVoiceSettings({ speed: 1, pitch: 0 });
    const b = fingerprintVoiceSettings({ pitch: 0, speed: 1 });
    expect(a).toBe(b);
  });

  it('produces a different hash for different values', () => {
    const a = fingerprintVoiceSettings({ speed: 1 });
    const b = fingerprintVoiceSettings({ speed: 2 });
    expect(a).not.toBe(b);
  });

  it('handles null/undefined/empty settings deterministically', () => {
    expect(fingerprintVoiceSettings(null)).toBe(fingerprintVoiceSettings(undefined));
    expect(fingerprintVoiceSettings({})).toBe(fingerprintVoiceSettings(null));
  });
});

describe('FirstPhraseCache', () => {
  it('misses on an empty cache', () => {
    const cache = new FirstPhraseCache({ dir: TEST_DIR });
    expect(cache.get(baseKey())).toBeNull();
  });

  it('put() then get() returns a path to a copy of the audio', () => {
    const cache = new FirstPhraseCache({ dir: TEST_DIR });
    const src = writeSourceAudio('a.wav', 'hello-audio');
    const stored = cache.put(baseKey(), src);
    expect(stored).not.toBe(src);
    expect(safeExistsSync(stored)).toBe(true);
    expect(String(safeReadFile(stored, { encoding: 'utf8' }))).toBe('hello-audio');

    const hit = cache.get(baseKey());
    expect(hit).toBe(stored);
  });

  it('keys on (engine, voiceId, voiceRevision, settingsFingerprint, text) — swapping the voice misses', () => {
    const cache = new FirstPhraseCache({ dir: TEST_DIR });
    const src = writeSourceAudio('a.wav');
    cache.put(baseKey(), src);

    expect(cache.get(baseKey({ voiceId: 'voice-b' }))).toBeNull();
    expect(cache.get(baseKey({ voiceRevision: 'rev-2' }))).toBeNull();
    expect(
      cache.get(baseKey({ settingsFingerprint: fingerprintVoiceSettings({ speed: 2 }) }))
    ).toBeNull();
    expect(cache.get(baseKey({ text: 'こんばんは' }))).toBeNull();
    expect(cache.get(baseKey({ engine: 'other-engine' }))).toBeNull();
  });

  it('reports a miss and drops the index row when the blob is missing on disk', () => {
    const cache = new FirstPhraseCache({ dir: TEST_DIR });
    const src = writeSourceAudio('a.wav');
    const stored = cache.put(baseKey(), src);
    safeRmSync(stored, { force: true });

    expect(cache.get(baseKey())).toBeNull();
    // Re-checking again should still be a clean miss (no crash on the dropped row).
    expect(cache.get(baseKey())).toBeNull();
  });

  it('purgeVoice() removes every entry for that voiceId and returns the count', () => {
    const cache = new FirstPhraseCache({ dir: TEST_DIR });
    const src1 = writeSourceAudio('a.wav');
    const src2 = writeSourceAudio('b.wav');
    cache.put(baseKey({ text: 'text-1' }), src1);
    const stored2 = cache.put(baseKey({ text: 'text-2', voiceId: 'voice-keep' }), src2);

    const removed = cache.purgeVoice('voice-a');
    expect(removed).toBe(1);
    expect(cache.get(baseKey({ text: 'text-1' }))).toBeNull();
    // Untouched voice's entry survives.
    expect(cache.get(baseKey({ text: 'text-2', voiceId: 'voice-keep' }))).toBe(stored2);
  });

  it('purgeVoice() returns 0 when nothing matches', () => {
    const cache = new FirstPhraseCache({ dir: TEST_DIR });
    expect(cache.purgeVoice('nonexistent-voice')).toBe(0);
  });

  it('evicts the least-recently-used entry once maxEntries is exceeded', () => {
    let now = 0;
    const cache = new FirstPhraseCache({ dir: TEST_DIR, maxEntries: 2, now: () => now });
    const src1 = writeSourceAudio('a.wav');
    const src2 = writeSourceAudio('b.wav');
    const src3 = writeSourceAudio('c.wav');

    now = 1;
    cache.put(baseKey({ text: 'first' }), src1);
    now = 2;
    cache.put(baseKey({ text: 'second' }), src2);
    now = 3;
    cache.put(baseKey({ text: 'third' }), src3);

    // 'first' was the LRU entry when the third put overflowed maxEntries=2.
    expect(cache.get(baseKey({ text: 'first' }))).toBeNull();
    expect(cache.get(baseKey({ text: 'second' }))).not.toBeNull();
    expect(cache.get(baseKey({ text: 'third' }))).not.toBeNull();
  });

  it('a get() refreshes LRU order so a recently-hit entry survives eviction', () => {
    let now = 0;
    const cache = new FirstPhraseCache({ dir: TEST_DIR, maxEntries: 2, now: () => now });
    const src1 = writeSourceAudio('a.wav');
    const src2 = writeSourceAudio('b.wav');
    const src3 = writeSourceAudio('c.wav');

    now = 1;
    cache.put(baseKey({ text: 'first' }), src1);
    now = 2;
    cache.put(baseKey({ text: 'second' }), src2);
    now = 3;
    // Touch 'first' so it becomes the most-recently-used entry.
    cache.get(baseKey({ text: 'first' }));
    now = 4;
    cache.put(baseKey({ text: 'third' }), src3);

    // 'second' is now the LRU entry, not 'first'.
    expect(cache.get(baseKey({ text: 'second' }))).toBeNull();
    expect(cache.get(baseKey({ text: 'first' }))).not.toBeNull();
    expect(cache.get(baseKey({ text: 'third' }))).not.toBeNull();
  });

  it('defaults to pathResolver.shared("runtime/voice-first-phrase-cache") when no dir is given', () => {
    const cache = new FirstPhraseCache();
    expect(cache.get(baseKey())).toBeNull();
  });
});
