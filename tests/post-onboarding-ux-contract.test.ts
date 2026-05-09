import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const ROOT = process.cwd();

function read(relPath: string): string {
  return String(safeReadFile(path.join(ROOT, relPath), { encoding: 'utf8' }) || '');
}

describe('post-onboarding ux contract', () => {
  it('documents customer overlay connections as the review target', () => {
    const roadmap = read('docs/developer/architecture/POST_ONBOARDING_UX_ROADMAP.md');
    const revolution = read('docs/developer/architecture/ONBOARDING_REVOLUTION.md');

    expect(roadmap).toContain('customer/{slug}/connections/*.json');
    expect(roadmap).toContain('KYBERION_CUSTOMER` 未設定時は `knowledge/personal/connections/*.json`');
    expect(revolution).toContain('customer/{slug}/connections/*.json');
    expect(revolution).toContain('customer/{slug}/tenants/{tenant_slug}.json');
  });
});
