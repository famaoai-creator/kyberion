import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  sha256,
  type MarketingCompletionEvidence,
} from '@agent/core';
import { validateMarketingMissionCompletionGate } from './mission-governance.js';

const roots: string[] = [];

function createFixture(): { missionPath: string; artifactPath: string } {
  const missionPath = pathResolver.shared(`tmp/mission-marketing-completion-tests/${randomUUID()}`);
  roots.push(missionPath);
  const runPath = path.join(missionPath, 'evidence', 'marketing-video', 'runs', 'run-1');
  safeMkdir(runPath, { recursive: true });
  const artifactPath = path.join(runPath, 'video.mp4');
  safeWriteFile(artifactPath, 'video-v1');
  const binding = {
    path: artifactPath,
    sha256: sha256(safeReadFile(artifactPath) as Buffer),
  };
  const evidence: MarketingCompletionEvidence = {
    workload: 'marketing-video-production',
    run_id: 'run-1',
    publication_intent: 'none',
    dry_run: true,
    required_gates: ['G0', 'G1', 'G3'],
    gate_results: [
      { gate_id: 'G0', status: 'passed', reasons: [], evidence: ['intake'] },
      { gate_id: 'G1', status: 'passed', reasons: [], evidence: ['scan'] },
      { gate_id: 'G3', status: 'passed', reasons: [], evidence: ['probe'] },
    ],
    artifact_bindings: { video: binding },
    sensitive_data_scan: { pii_findings: [], secret_findings: [], passed: true },
    completion_eligible: true,
  };
  safeWriteFile(path.join(runPath, 'completion-evidence.json'), JSON.stringify(evidence));
  return { missionPath, artifactPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

describe('mission marketing completion gate', () => {
  it('accepts current bound evidence', () => {
    const fixture = createFixture();
    expect(
      validateMarketingMissionCompletionGate({
        missionType: 'marketing-video-production',
        missionPath: fixture.missionPath,
      })
    ).toEqual({ ok: true });
  });

  it('rejects an artifact changed after completion evidence', () => {
    const fixture = createFixture();
    safeWriteFile(fixture.artifactPath, 'video-v2');
    expect(
      validateMarketingMissionCompletionGate({
        missionType: 'marketing-video-production',
        missionPath: fixture.missionPath,
      }).reason
    ).toContain('marketing completion artifact changed: video');
  });

  it('rejects missing completion evidence for marketing missions', () => {
    const missionPath = pathResolver.shared(
      `tmp/mission-marketing-completion-tests/${randomUUID()}`
    );
    roots.push(missionPath);
    safeMkdir(path.join(missionPath, 'evidence'), { recursive: true });
    expect(
      validateMarketingMissionCompletionGate({
        missionType: 'marketing-video-production',
        missionPath,
      })
    ).toEqual({ ok: false, reason: 'Marketing mission requires completion-evidence.json.' });
  });

  it('does not alter non-marketing mission completion', () => {
    expect(
      validateMarketingMissionCompletionGate({ missionType: 'development', missionPath: null })
    ).toEqual({ ok: true });
  });
});
