import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pathResolver,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { createArtifactRecord, saveArtifactRecord } from '@agent/core';
import { validateMissionQuality } from './mission-governance.js';

const previousPersona = process.env.KYBERION_PERSONA;
const previousRole = process.env.MISSION_ROLE;

function prepareMission(missionId: string): string {
  const missionPath = pathResolver.missionDir(missionId, 'public');
  const latestCommit = safeExec('git', ['rev-parse', 'HEAD'], {
    cwd: pathResolver.rootDir(),
  }).trim();
  if (!safeExistsSync(missionPath)) safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    `${missionPath}/mission-state.json`,
    JSON.stringify(
      {
        mission_id: missionId,
        tier: 'public',
        status: 'completed',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'tester',
        confidence_score: 1,
        git: {
          branch: 'test',
          start_commit: 'abc123',
          latest_commit: latestCommit,
          checkpoints: [],
        },
        history: [],
      },
      null,
      2
    )
  );
  return missionPath;
}

beforeEach(() => {
  process.env.KYBERION_PERSONA = 'worker';
  process.env.MISSION_ROLE = 'mission_controller';
});

afterEach(() => {
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
  if (previousRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousRole;
});

describe('mission-governance quality validation', () => {
  it('blocks finish when a mission artifact fails deliverable quality', async () => {
    const missionId = 'MSN-GOVERNANCE-QUALITY-FAIL';
    const missionPath = prepareMission(missionId);
    const artifact = createArtifactRecord({
      mission_id: missionId,
      kind: 'code',
      storage_class: 'artifact_store',
      path: `${missionPath}/evidence/bad-code.json`,
      preview_text: 'broken artifact',
      metadata: {
        build_passed: false,
        lint_passed: true,
        tests_passed: true,
      },
    });
    saveArtifactRecord(artifact);

    const quality = await validateMissionQuality(missionId);
    expect(quality.ok).toBe(false);
    expect(quality.reason).toContain('build failed');
    safeRmSync(missionPath, { recursive: true, force: true });
  });

  it('allows finish when mission artifacts satisfy deliverable quality', async () => {
    const missionId = 'MSN-GOVERNANCE-QUALITY-PASS';
    const missionPath = prepareMission(missionId);
    const artifact = createArtifactRecord({
      mission_id: missionId,
      kind: 'doc',
      storage_class: 'artifact_store',
      path: `${missionPath}/evidence/good-doc.md`,
      preview_text: [
        '# Mission Summary',
        '',
        '## Outcome',
        '',
        'This document contains structured content with enough detail to pass the baseline gate.',
      ].join('\n'),
    });
    saveArtifactRecord(artifact);

    const quality = await validateMissionQuality(missionId);
    expect(quality.ok).toBe(true);
    safeRmSync(missionPath, { recursive: true, force: true });
  });
});
