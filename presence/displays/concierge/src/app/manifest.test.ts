import { safeReadFile } from '@agent/core/secure-io';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from './manifest';

describe('concierge web app manifest', () => {
  const m = manifest();

  it('is installable: standalone, root scope, 192 and 512 PNG icons', () => {
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect((m.icons ?? []).some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('every declared icon exists as a PNG under public/', () => {
    for (const icon of m.icons ?? []) {
      const file = path.join(__dirname, '..', '..', 'public', icon.src);
      const head = (safeReadFile(file, { encoding: null }) as Buffer).subarray(0, 8);
      expect([...head]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });
});

describe('service worker', () => {
  const sw = safeReadFile(path.join(__dirname, '..', '..', 'public', 'sw.js'), {
    encoding: 'utf8',
  }) as string;

  it('never caches live data: only the offline page, only for navigations', () => {
    expect(sw).toContain("request.mode !== 'navigate'");
    expect(sw).toContain("request.method !== 'GET'");
    expect(sw).not.toMatch(/cache\.put|addAll/);
  });
});
