import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('service integration plan contract', () => {
  it('documents customer overlay connections as the active private overlay', () => {
    const doc = read('docs/developer/architecture/service-integration-plan.md');
    expect(doc).toContain('customer/{slug}/connections/{service}.json');
    expect(doc).toContain('otherwise `knowledge/personal/connections/{service}.json`');
    expect(doc).toContain('active private overlay');
  });
});
