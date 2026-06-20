import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('TaskScenario quickstart contract', () => {
  it('keeps the roadmap linked to the quickstart', () => {
    const roadmap = read('docs/TASK_SCENARIO_ROADMAP.md');
    expect(roadmap).toContain('TaskScenario Quickstart');
    expect(roadmap).toContain('./TASK_SCENARIO_QUICKSTART.md');
    expect(roadmap).toContain('pnpm task:list');
    expect(roadmap).toContain('pnpm task:init <task-id>');
    expect(roadmap).toContain('pnpm task:run <task-id> --dry-run');
  });

  it('keeps the quickstart copy-paste flow and safety note intact', () => {
    const quickstart = read('docs/TASK_SCENARIO_QUICKSTART.md');

    expect(quickstart).toContain('pnpm task:list');
    expect(quickstart).toContain('pnpm task:init daily-email-triage');
    expect(quickstart).toContain('pnpm task:run daily-email-triage --dry-run');
    expect(quickstart).toContain('--dry-run');
    expect(quickstart).toContain('no external send');
    expect(quickstart).toContain('日程調整と受領確認のみ');
    expect(quickstart).toContain('外部送信は常に承認');
  });

  it('documents the expected operator flow for a first-time user', () => {
    const quickstart = read('docs/TASK_SCENARIO_QUICKSTART.md');
    expect(quickstart).toContain('Profile created: knowledge/personal/task-profiles/daily-email-triage.json');
    expect(quickstart).toContain('TaskScenario: daily-email-triage');
    expect(quickstart).toContain('Approval required before: external send');
    expect(quickstart).toContain('knowledge/personal/task-profiles/daily-email-triage.json');
  });
});
