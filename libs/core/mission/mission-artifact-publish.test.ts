/**
 * Hermetic tests for publishing a mission evidence file as a deliverable
 * (`mission publish-artifact`) and for its hand-off to `finish` promotion.
 *
 * KM-04 convention: a temp KYBERION_ROOT is created and set BEFORE any repo
 * module is imported (path-resolver binds its project root at import time),
 * so nothing here ever touches the real active/ tree. Raw fs is used only to
 * seed/inspect the temp root (registered in tests/core-fs-exception-boundary).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MissionState } from './mission-types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HTML = '<!doctype html><title>report</title><p>final</p>';

let tmpRoot: string;
let publish: typeof import('./mission-artifact-publish.js');
let promotion: typeof import('./mission-artifact-promotion.js');
let records: typeof import('../workforce/artifact-record.js');
let projects: typeof import('../project/project-registry.js');
let missionState: typeof import('./mission-state.js');

function missionDir(missionId: string): string {
  return path.join(tmpRoot, 'active/missions', missionId);
}

function seedMission(
  missionId: string,
  state: Record<string, unknown> = {},
  evidence: Record<string, string> = { 'final.html': HTML }
): void {
  const dir = missionDir(missionId);
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  for (const [name, body] of Object.entries(evidence)) {
    fs.writeFileSync(path.join(dir, 'evidence', name), body);
  }
  fs.writeFileSync(
    path.join(dir, 'mission-state.json'),
    JSON.stringify({
      mission_id: missionId,
      status: 'active',
      tier: 'public',
      execution_mode: 'local',
      priority: 1,
      org_role: 'worker',
      confidence_score: 1,
      git: { branch: 'm', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
      history: [],
      ...state,
    })
  );
}

describe('mission publish-artifact', () => {
  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyb-artifact-publish-'));
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    const governance = path.join(tmpRoot, 'knowledge/product/governance');
    fs.mkdirSync(governance, { recursive: true });
    for (const file of ['agent-policies.yaml', 'security-policy.json']) {
      fs.copyFileSync(
        path.join(REPO_ROOT, 'knowledge/product/governance', file),
        path.join(governance, file)
      );
    }
    // ArtifactRecord validation ($ref chain) needs the full schema directory.
    fs.cpSync(
      path.join(REPO_ROOT, 'knowledge/product/schemas'),
      path.join(tmpRoot, 'knowledge/product/schemas'),
      { recursive: true }
    );
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';
    vi.stubEnv('KYBERION_BASE_ROLE', 'sovereign');
    publish = await import('./mission-artifact-publish.js');
    promotion = await import('./mission-artifact-promotion.js');
    records = await import('../workforce/artifact-record.js');
    projects = await import('../project/project-registry.js');
    missionState = await import('./mission-state.js');
    projects.saveProjectRecord({
      project_id: 'proj-a',
      name: 'proj-a',
      summary: 'Publish test project.',
      status: 'active',
      tier: 'public',
    } as Parameters<typeof projects.saveProjectRecord>[0]);
    seedMission('MSN-PUB-A');
    seedMission('MSN-PUB-LINKED', { relationships: { project: { project_id: 'proj-a' } } });
    seedMission('MSN-PUB-DONE', { status: 'completed' });
    seedMission('MSN-PUB-ODD', {}, { 'notes.unknownext': 'x' });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('publishes an evidence file as a report with a record and a mission-scoped copy', () => {
    const result = publish.publishMissionEvidenceArtifact({
      missionId: 'msn-pub-a',
      evidencePath: 'evidence/final.html',
      name: 'cost-report.html',
    });
    expect(result).toMatchObject({
      mission_id: 'MSN-PUB-A',
      artifact_class: 'report',
      kind: 'html',
      source: 'evidence/final.html',
      destination: 'owner_floor',
    });
    expect(result.artifact_id).toMatch(/^ART-PUB-[0-9A-F]{16}$/);
    expect(result.path).toBe('active/missions/MSN-PUB-A/artifacts/report/cost-report.html');
    expect(fs.readFileSync(path.join(tmpRoot, result.path), 'utf8')).toBe(HTML);
    const record = records.loadArtifactRecord(result.artifact_id);
    expect(record).toMatchObject({
      kind: 'html',
      mission_id: 'MSN-PUB-A',
      path: result.path,
    });
    // The evidence original is untouched.
    expect(fs.readFileSync(path.join(missionDir('MSN-PUB-A'), 'evidence/final.html'), 'utf8')).toBe(
      HTML
    );
  });

  it('accepts a bare evidence-relative path and defaults the name from the file', () => {
    const result = publish.publishMissionEvidenceArtifact({
      missionId: 'MSN-PUB-A',
      evidencePath: 'final.html',
    });
    expect(result.path).toBe('active/missions/MSN-PUB-A/artifacts/report/final.html');
  });

  it('is idempotent: the same bytes republish the same record and index row', () => {
    const input = {
      missionId: 'MSN-PUB-A',
      evidencePath: 'evidence/final.html',
      name: 'idem.html',
    };
    const first = publish.publishMissionEvidenceArtifact(input);
    const second = publish.publishMissionEvidenceArtifact(input);
    expect(second.artifact_id).toBe(first.artifact_id);
    expect(second.path).toBe(first.path);
    const index = fs
      .readFileSync(path.join(missionDir('MSN-PUB-A'), 'artifacts/artifacts-index.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('idem.html'));
    expect(index).toHaveLength(1);
  });

  it('refuses files outside the mission evidence tree', () => {
    fs.writeFileSync(path.join(tmpRoot, 'outside.html'), 'x');
    for (const evidencePath of [
      '../mission-state.json',
      'evidence/../mission-state.json',
      path.join(tmpRoot, 'outside.html'),
      'active/missions/MSN-PUB-LINKED/evidence/final.html',
    ]) {
      expect(() =>
        publish.publishMissionEvidenceArtifact({ missionId: 'MSN-PUB-A', evidencePath })
      ).toThrow(/MISSION_PUBLISH_ARTIFACT/);
    }
  });

  it('refuses a directory, a missing file, a hard link and an unregistered kind', () => {
    fs.mkdirSync(path.join(missionDir('MSN-PUB-A'), 'evidence/sub'), { recursive: true });
    fs.writeFileSync(path.join(missionDir('MSN-PUB-A'), 'evidence/original.html'), HTML);
    fs.linkSync(
      path.join(missionDir('MSN-PUB-A'), 'evidence/original.html'),
      path.join(missionDir('MSN-PUB-A'), 'evidence/linked.html')
    );
    for (const evidencePath of ['evidence/sub', 'evidence/nope.html', 'evidence/linked.html']) {
      expect(() =>
        publish.publishMissionEvidenceArtifact({ missionId: 'MSN-PUB-A', evidencePath })
      ).toThrow();
    }
    expect(() =>
      publish.publishMissionEvidenceArtifact({
        missionId: 'MSN-PUB-ODD',
        evidencePath: 'notes.unknownext',
      })
    ).toThrow(/cannot choose an artifact kind/);
    expect(() =>
      publish.publishMissionEvidenceArtifact({
        missionId: 'MSN-PUB-A',
        evidencePath: 'final.html',
        kind: 'not-a-kind',
      })
    ).toThrow(/not a registered kind/);
  });

  it('refuses an unpublishable class and a finished mission', () => {
    expect(() =>
      publish.publishMissionEvidenceArtifact({
        missionId: 'MSN-PUB-A',
        evidencePath: 'final.html',
        artifactClass: 'evidence' as never,
      })
    ).toThrow(/not publishable/);
    expect(() =>
      publish.publishMissionEvidenceArtifact({
        missionId: 'MSN-PUB-DONE',
        evidencePath: 'final.html',
      })
    ).toThrow(/is completed/);
    expect(() =>
      publish.publishMissionEvidenceArtifact({ missionId: 'MSN-PUB-MISSING', evidencePath: 'x' })
    ).toThrow(/not found/);
  });

  it('hands the published deliverable to the linked project at finish', () => {
    const result = publish.publishMissionEvidenceArtifact({
      missionId: 'MSN-PUB-LINKED',
      evidencePath: 'final.html',
      name: 'linked.html',
    });
    expect(result.destination).toBe('project');
    expect(result.project_id).toBe('proj-a');
    const state = missionState.loadState('MSN-PUB-LINKED') as MissionState;
    const outcome = promotion.promoteMissionArtifactsToProject({
      missionId: 'MSN-PUB-LINKED',
      missionDir: missionDir('MSN-PUB-LINKED'),
      state,
    });
    expect(outcome.status).toBe('promoted');
    expect(outcome.promoted).toHaveLength(1);
    const promotedTo = outcome.promoted[0].to;
    expect(promotedTo).toContain('proj-a');
    expect(fs.readFileSync(path.join(tmpRoot, promotedTo), 'utf8')).toBe(HTML);
    expect(records.loadArtifactRecord(result.artifact_id)?.project_id).toBe('proj-a');
  });
});
