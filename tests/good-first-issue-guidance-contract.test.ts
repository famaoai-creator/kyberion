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
  });

  it('links contributor guidance from the PR contract to the starter-task guide', () => {
    const contributing = read('CONTRIBUTING.md');
    expect(contributing).toContain('docs/developer/GOOD_FIRST_ISSUES.md');
    expect(contributing).toContain('good-first-issue');
    expect(contributing).toContain('pnpm validate');
  });

  it('advertises starter slices in the developer docs index', () => {
    const developerReadme = read('docs/developer/README.md');
    expect(developerReadme).toContain('GOOD_FIRST_ISSUES.md');
  });
});
