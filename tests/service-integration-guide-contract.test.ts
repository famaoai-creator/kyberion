import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('service integration guide contract', () => {
  it('documents current catalogs and governed connection setup', () => {
    const doc = read('knowledge/product/orchestration/service-integration-guide.md');
    expect(doc).toContain('service-endpoints/{service-id}.json');
    expect(doc).toContain('service-presets/{service-id}.json');
    expect(doc).toContain('pnpm kyberion secret introduce');
    expect(doc).toContain('pnpm service:preflight');
    expect(doc).toContain('customer/{slug}/` overlay');
  });
});
