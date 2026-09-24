/**
 * On-disk LRU cache for pre-synthesized "first phrase" TTS audio (EV-04).
 *
 * Keyed on (engine, voiceId, voiceRevision, settingsFingerprint, text) so a
 * voice swap or a settings change (which changes `voiceRevision` /
 * `settingsFingerprint`) can never replay stale audio from a different
 * voice — the key changes, so the old entry simply misses. All I/O goes
 * through `secure-io`; storage lives under `pathResolver.shared('runtime/
 * voice-first-phrase-cache')` by default (explicit-opt-in callers may point
 * `dir` elsewhere, e.g. a mission-local scratch dir in tests).
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeUnlinkSync,
  safeWriteFile,
  loadJsonIfPresent,
} from './secure-io.js';

export interface FirstPhraseCacheKey {
  engine: string;
  voiceId: string;
  voiceRevision: string;
  settingsFingerprint: string;
  text: string;
}

export interface FirstPhraseCacheOptions {
  /** Cache root directory. Defaults to `pathResolver.shared('runtime/voice-first-phrase-cache')`. */
  dir?: string;
  /** Maximum number of entries retained; oldest-accessed evicted first. Default 64. */
  maxEntries?: number;
  /** Wall-clock source (injectable for tests). Default Date.now. */
  now?: () => number;
}

interface CacheIndexEntry {
  hash: string;
  engine: string;
  voiceId: string;
  voiceRevision: string;
  settingsFingerprint: string;
  text: string;
  fileName: string;
  lastAccessMs: number;
}

interface CacheIndex {
  entries: CacheIndexEntry[];
}

const DEFAULT_MAX_ENTRIES = 64;

/**
 * Stable sha256 hex of an arbitrary settings object — object keys are
 * sorted before serialization so build order never affects the hash.
 */
export function fingerprintVoiceSettings(
  settings: Record<string, unknown> | null | undefined
): string {
  if (!settings || Object.keys(settings).length === 0) {
    return crypto.createHash('sha256').update('{}').digest('hex');
  }
  const sorted = Object.fromEntries(
    Object.keys(settings)
      .sort()
      .map((k) => [k, settings[k]])
  );
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function hashKey(key: FirstPhraseCacheKey): string {
  const parts = [
    key.engine,
    key.voiceId,
    key.voiceRevision,
    key.settingsFingerprint,
    key.text,
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex');
}

export class FirstPhraseCache {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: FirstPhraseCacheOptions = {}) {
    this.dir = path.resolve(options.dir ?? pathResolver.shared('runtime/voice-first-phrase-cache'));
    this.indexPath = path.join(this.dir, 'index.json');
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns the cached audio path for `key`, or null on a miss. Touches LRU on a hit. */
  get(key: FirstPhraseCacheKey): string | null {
    const hash = hashKey(key);
    const index = this.readIndex();
    const entry = index.entries.find((e) => e.hash === hash);
    if (!entry) return null;

    const filePath = path.join(this.dir, entry.fileName);
    if (!safeExistsSync(filePath)) {
      // Orphan index row (blob missing) — drop it and report a miss.
      index.entries = index.entries.filter((e) => e.hash !== hash);
      this.writeIndex(index);
      return null;
    }

    entry.lastAccessMs = this.now();
    this.writeIndex(index);
    return filePath;
  }

  /** Store `audioPath`'s bytes under `key`, evicting LRU entries beyond `maxEntries`. Returns the stored path. */
  put(key: FirstPhraseCacheKey, audioPath: string): string {
    safeMkdir(this.dir);
    const hash = hashKey(key);
    const ext = path.extname(audioPath) || '.bin';
    const fileName = `${hash}${ext}`;
    const destPath = assertSafeRepositoryPath(path.join(this.dir, fileName), {
      allowMissingLeaf: true,
    });
    safeCopyFileSync(audioPath, destPath);

    const index = this.readIndex();
    index.entries = index.entries.filter((e) => e.hash !== hash);
    index.entries.push({
      hash,
      engine: key.engine,
      voiceId: key.voiceId,
      voiceRevision: key.voiceRevision,
      settingsFingerprint: key.settingsFingerprint,
      text: key.text,
      fileName,
      lastAccessMs: this.now(),
    });
    this.evictOverflow(index);
    this.writeIndex(index);
    return destPath;
  }

  /** Remove every entry for `voiceId`, deleting their blobs. Returns the number removed. */
  purgeVoice(voiceId: string): number {
    const index = this.readIndex();
    const toRemove = index.entries.filter((e) => e.voiceId === voiceId);
    if (toRemove.length === 0) return 0;
    for (const entry of toRemove) {
      safeUnlinkSync(path.join(this.dir, entry.fileName));
    }
    index.entries = index.entries.filter((e) => e.voiceId !== voiceId);
    this.writeIndex(index);
    return toRemove.length;
  }

  private evictOverflow(index: CacheIndex): void {
    if (index.entries.length <= this.maxEntries) return;
    // Oldest-accessed first.
    index.entries.sort((a, b) => a.lastAccessMs - b.lastAccessMs);
    while (index.entries.length > this.maxEntries) {
      const evicted = index.entries.shift();
      if (!evicted) break;
      safeUnlinkSync(path.join(this.dir, evicted.fileName));
    }
  }

  private readIndex(): CacheIndex {
    const loaded = loadJsonIfPresent<CacheIndex>(this.indexPath);
    if (!loaded || !Array.isArray(loaded.entries)) return { entries: [] };
    return loaded;
  }

  private writeIndex(index: CacheIndex): void {
    safeMkdir(this.dir);
    safeWriteFile(this.indexPath, JSON.stringify(index, null, 2));
  }
}
