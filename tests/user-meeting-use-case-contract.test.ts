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
    expect(guide).toContain('pnpm run test:meeting-dry-run');
    expect(guide).toContain('pnpm doctor:meeting --mission MSN-...');
    expect(guide).toContain('before recording/capture starts and again before TTS speech');
    expect(guide).toContain('Meeting URLs are logged as redacted host-only values');
    expect(guide).toContain('Dry run vs real meeting');
  });

  it('keeps the architecture use-case aligned with live participation guardrails', () => {
    const architecture = read('knowledge/public/architecture/meeting-facilitator-use-case.md');
    expect(architecture).toContain('Participation consent (`meeting:participate`)');
    expect(architecture).toContain('meeting_participation.recording_denied');
    expect(architecture).toContain('meeting_participation.speak_denied');
    expect(architecture).toContain('pnpm run test:meeting-dry-run');
  });
});
