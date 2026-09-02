import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDirectEntry } from './direct-entry.js';

describe('isDirectEntry', () => {
  const entryPath = path.resolve('/repo/dist/satellites/discord-bridge/src/index.js');
  const moduleUrl = pathToFileURL(entryPath).href;

  it('accepts the compiled counterpart of the expected TypeScript entry', () => {
    expect(isDirectEntry(moduleUrl, 'satellites/discord-bridge/src/index.ts', entryPath)).toBe(
      true
    );
  });

  it('rejects imports and unrelated entrypoints', () => {
    expect(isDirectEntry(moduleUrl, 'satellites/discord-bridge/src/index.ts', undefined)).toBe(
      false
    );
    expect(isDirectEntry(moduleUrl, 'satellites/slack-bridge/src/index.ts', entryPath)).toBe(false);
  });
});
