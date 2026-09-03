import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import {
  loadI18nCoverageHistoryAtPath,
  writeI18nCoverageHistoryAtPath,
} from './i18n-coverage-history.js';

const root = pathResolver.sharedTmp(`i18n-coverage-history-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

const snapshot = {
  recorded_at: '2026-09-03T00:00:00.000Z',
  locales: { en: 100, ja: 66.67 },
};

describe('i18n coverage history loader', () => {
  it('validates and reloads a coverage snapshot through the shared contract', () => {
    const file = path.join(root, 'history.json');
    safeMkdir(root, { recursive: true });

    expect(writeI18nCoverageHistoryAtPath(file, snapshot)).toEqual(snapshot);
    expect(loadI18nCoverageHistoryAtPath(file)).toEqual(snapshot);
  });

  it('rejects malformed coverage history before regression comparison', () => {
    const file = path.join(root, 'history.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(file, JSON.stringify({ ...snapshot, unexpected: true }));

    expect(() => loadI18nCoverageHistoryAtPath(file)).toThrow(
      /Invalid catalog i18n-coverage-history/u
    );
  });

  it('returns null for a missing snapshot and rejects symlinked history', () => {
    const file = path.join(root, 'history.json');
    expect(loadI18nCoverageHistoryAtPath(file)).toBeNull();

    const outside = path.join(root, 'outside');
    const link = path.join(root, 'linked-history.json');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'real.json'), JSON.stringify(snapshot));
    safeSymlinkSync(path.join(outside, 'real.json'), link);

    expect(() => loadI18nCoverageHistoryAtPath(link)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
