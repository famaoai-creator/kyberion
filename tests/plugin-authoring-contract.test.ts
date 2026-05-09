import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Plugin authoring contract', () => {
  it('points out-of-tree readers to the runtime plugins readme instead of a fake installer', () => {
    const guide = read('docs/developer/PLUGIN_AUTHORING.md');
    expect(guide).toContain('../../plugins/README.md');
    expect(guide).not.toContain('pnpm plugin install <path>');
  });
});
