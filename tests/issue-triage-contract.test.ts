import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

function read(relativePath: string): string {
  return safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string;
}

describe('issue triage contract', () => {
  it('documents how to handle synthetic test issues', () => {
    const triage = read('docs/developer/ISSUE_TRIAGE.md');

    expect(triage).toContain('Synthetic test issues created for automation validation');
    expect(triage).toContain('GitHub issue #147');
    expect(triage).toContain('docs/test PR');
  });
});
