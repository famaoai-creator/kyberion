import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Voice upgrade contract', () => {
  it('states that upgrade commands exist while runtime switching remains pending', () => {
    const doc = read('docs/developer/VOICE_FIRST_WIN.md');
    expect(doc).toContain('pnpm voice:upgrade cloud');
    expect(doc).toContain('pnpm voice:upgrade local');
    expect(doc).toContain('implemented as configurators');
    expect(doc).toContain('full end-to-end runtime switching');
    expect(doc).not.toContain('Both upgrade scripts are not yet implemented');
    expect(doc).not.toContain('Sets KYBERION_VOICE_TIER=1');
  });

  it('keeps the upgrade surface as one package entrypoint', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['voice:upgrade']).toBeDefined();
    expect(packageJson.scripts['voice:upgrade-cloud']).toBeUndefined();
    expect(packageJson.scripts['voice:upgrade-local']).toBeUndefined();
  });
});
