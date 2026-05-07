import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('User meeting use-case contract', () => {
  it('exposes the meeting facilitator guide from the user docs index', () => {
    const userReadme = read('docs/user/README.md');
    expect(userReadme).toContain('meeting-facilitator.md');
    expect(userReadme).toContain('meeting use-case and safety boundaries');
  });

  it('documents consent, dry-run, and real meeting boundaries', () => {
    const guide = read('docs/user/meeting-facilitator.md');
    expect(guide).toContain('voice-consent.json');
    expect(guide).toContain('meeting:consent grant');
    expect(guide).toContain('meeting:participate');
    expect(guide).toContain('pnpm cli preview pipelines/meeting-proxy-workflow.json');
    expect(guide).toContain('Dry run vs real meeting');
  });
});
