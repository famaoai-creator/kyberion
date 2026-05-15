import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Good first issue guidance contract', () => {
  it('keeps the issue template pointing at the starter-task guide', () => {
    const template = read('.github/ISSUE_TEMPLATE/good-first-issue-guide.md');
    expect(template).toContain('docs/developer/GOOD_FIRST_ISSUES.md');
    expect(template).toContain('Add a troubleshooting note for `pnpm doctor`');
    expect(template).toContain('Reword one release workflow step');
    expect(template).toContain('Estimated time: 1-2 hours');
    expect(template).toContain('Files expected:');
    expect(template).toContain('Validation command:');
    expect(template).toContain('Out of scope:');
    expect(template).toContain('Good first issue checklist');
  });

  it('links contributor guidance from the PR contract to the starter-task guide', () => {
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('docs/developer/GOOD_FIRST_ISSUES.md');
    expect(contributing).toContain('good-first-issue');
    expect(contributing).toContain('pnpm validate');
    expect(contributing).toContain('one small file cluster');
    expect(contributing).toContain('one validation command');
  });

  it('advertises starter slices in the developer docs index', () => {
    const developerReadme = read('docs/developer/README.md');
    expect(developerReadme).toContain('GOOD_FIRST_ISSUES.md');
  });

  it('cuts P1/P2 work into concrete 1-2 hour slices', () => {
    const guide = read('docs/developer/GOOD_FIRST_ISSUES.md');
    expect(guide).toContain('## 1-2 hour task contract');
    expect(guide).toContain('Estimated time: 1-2 hours');
    expect(guide).toContain('Files expected');
    expect(guide).toContain('Validation command');
    expect(guide).toContain('Out of scope');
    expect(guide).toContain('libs/core/error-classifier.ts');
    expect(guide).toContain('pnpm run test:meeting-dry-run');
    expect(guide).toContain('tests/release-operations-contract.test.ts');
    expect(guide).toContain('tests/first-win-docs-contract.test.ts');
    expect(guide).toContain('tests/developer-tour-contract.test.ts');
    expect(guide).toContain('tests/user-meeting-use-case-contract.test.ts');
    expect(guide).toContain('.github/ISSUE_TEMPLATE/good-first-issue-guide.md');
  });
});
