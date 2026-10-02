/**
 * Hermetic tests for mission → project deliverable promotion and for the
 * organization digest's per-organization artifacts.
 *
 * KM-04 convention: a temp KYBERION_ROOT is created and set BEFORE any repo
 * module is imported (path-resolver binds its project root at import time),
 * so nothing here ever touches the real active/ tree. Raw fs is used only to
 * seed/inspect the temp root (registered in tests/core-fs-exception-boundary).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MissionState } from './mission-types.js';
import type { OrganizationDigest } from '../organization/organization-digest.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let tmpRoot: string;
let store: typeof import('../workforce/artifact-store.js');
let records: typeof import('../workforce/artifact-record.js');
let promotion: typeof import('./mission-artifact-promotion.js');
let digestArtifacts: typeof import('../organization/organization-digest-artifacts.js');
let pathResolver: typeof import('../path-resolver.js');

function missionState(missionId: string, projectId?: string): MissionState {
  return {
    mission_id: missionId,
    tier: 'public',
    status: 'completed',
    ...(projectId ? { relationships: { project: { project_id: projectId } } } : {}),
  } as unknown as MissionState;
}

describe('mission artifact promotion', () => {
  beforeAll(async () => {
    tmpRoot = path.join(os.tmpdir(), `kyb-artifact-promotion-${randomUUID()}`);
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    const policy = path.join(tmpRoot, 'knowledge/product/governance/agent-policies.yaml');
    fs.mkdirSync(path.dirname(policy), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, 'knowledge/product/governance/agent-policies.yaml'),
      policy
    );
    // ArtifactRecord validation ($ref chain) needs the full schema directory.
    fs.cpSync(
      path.join(REPO_ROOT, 'knowledge/product/schemas'),
      path.join(tmpRoot, 'knowledge/product/schemas'),
      { recursive: true }
    );
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';
    store = await import('../workforce/artifact-store.js');
    records = await import('../workforce/artifact-record.js');
    promotion = await import('./mission-artifact-promotion.js');
    digestArtifacts = await import('../organization/organization-digest-artifacts.js');
    pathResolver = await import('../path-resolver.js');
  });

  afterAll(() => {
    delete process.env.KYBERION_ROOT;
    delete process.env.MISSION_ROLE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies published report/export deliverables into the project and re-points the record', () => {
    const missionId = 'MSN-PROMOTE-A';
    const write = (
      artifactClass: 'report' | 'export' | 'evidence',
      name: string,
      publish: boolean,
      task?: string
    ) =>
      store.writeScopedArtifact({
        scope: { mission: missionId, ...(task ? { task } : {}) },
        tier: 'public',
        artifact_class: artifactClass,
        name,
        content: `${artifactClass}:${name}`,
        ...(publish ? { publish: { kind: 'report' as const } } : {}),
      });
    const report = write('report', 'summary.md', true);
    const taskExport = write('export', 'data.csv', true, 'T-1');
    write('report', 'draft.md', false); // unpublished — not a deliverable
    const evidence = write('evidence', 'log.json', true); // evidence stays with the mission

    const missionDir = pathResolver.missionDir(missionId, 'public');
    const result = promotion.promoteMissionArtifactsToProject({
      missionId,
      missionDir,
      state: missionState(missionId, 'proj-a'),
    });

    expect(result.status).toBe('promoted');
    expect(result.failed).toEqual([]);
    expect(result.promoted.map((entry) => entry.to).sort()).toEqual([
      'active/projects/public/shared/proj-a/artifacts/export/missions/MSN-PROMOTE-A/task-T-1/data.csv',
      'active/projects/public/shared/proj-a/artifacts/report/missions/MSN-PROMOTE-A/summary.md',
    ]);
    const promotedReport = records.loadArtifactRecord(report.artifact_id as string);
    expect(promotedReport).toMatchObject({
      project_id: 'proj-a',
      mission_id: missionId,
      path: 'active/projects/public/shared/proj-a/artifacts/report/missions/MSN-PROMOTE-A/summary.md',
      metadata: expect.objectContaining({ promoted_from: report.repo_relative_path }),
    });
    expect(fs.readFileSync(path.join(tmpRoot, promotedReport?.path as string), 'utf8')).toBe(
      'report:summary.md'
    );
    // Copy, not move: the original is archived with the mission.
    expect(fs.existsSync(report.absolute_path)).toBe(true);
    expect(fs.existsSync(taskExport.absolute_path)).toBe(true);
    expect(records.loadArtifactRecord(evidence.artifact_id as string)?.path).toBe(
      evidence.repo_relative_path
    );

    // Idempotent: a re-run finds no record still pointing at the mission tree.
    const rerun = promotion.promoteMissionArtifactsToProject({
      missionId,
      missionDir,
      state: missionState(missionId, 'proj-a'),
    });
    expect(rerun).toMatchObject({ status: 'nothing_to_promote', promoted: [] });
  });

  it('skips missions without a project link and never throws on a missing tree', () => {
    expect(
      promotion.promoteMissionArtifactsToProject({
        missionId: 'MSN-NO-PROJECT',
        missionDir: pathResolver.missionDir('MSN-NO-PROJECT', 'public'),
        state: missionState('MSN-NO-PROJECT'),
      })
    ).toMatchObject({ status: 'skipped', reason: 'no_project' });
    expect(
      promotion.promoteMissionArtifactsToProject({
        missionId: 'MSN-NO-TREE',
        missionDir: pathResolver.missionDir('MSN-NO-TREE', 'public'),
        state: missionState('MSN-NO-TREE', 'proj-a'),
      })
    ).toMatchObject({ status: 'nothing_to_promote', promoted: [], failed: [] });
  });

  it("files each organization's digest entry in that organization's own scope", () => {
    const entry = (organizationId: string, tier: 'public' | 'confidential', tenant?: string) => ({
      organization_id: organizationId,
      name: organizationId,
      tier,
      ...(tenant ? { tenant_slug: tenant } : {}),
      due_operations: [],
      deadlines: [],
      pending_decisions: [],
      expiring_services: [],
      stale_services: [],
      unobserved_services: [],
      open_incidents: [],
    });
    const digest = {
      kind: 'organization_digest',
      // 2026-10-01T20:00Z is already 2026-10-02 in Asia/Tokyo.
      generated_at: '2026-10-01T20:00:00.000Z',
      timezone: 'Asia/Tokyo',
      organizations: [entry('org-a', 'confidential', 'acme'), entry('org-b', 'public')],
    } as unknown as OrganizationDigest;

    const result = digestArtifacts.persistOrganizationDigest(digest);

    expect(result.failed).toEqual([]);
    expect(result.persisted.map((item) => item.path)).toEqual([
      'active/organizations/confidential/acme/org-a/artifacts/report/digests/2026-10-02.json',
      'active/organizations/public/shared/org-b/artifacts/report/digests/2026-10-02.json',
    ]);
    const record = records.loadArtifactRecord(result.persisted[0]?.artifact_id as string);
    expect(record).toMatchObject({ organization_id: 'org-a', tenant_slug: 'acme' });
    const stored = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, result.persisted[0]?.path as string), 'utf8')
    );
    // Only the organization's own entry is stored — never the cross-tenant digest.
    expect(stored).toMatchObject({ kind: 'organization_digest_entry', organization_id: 'org-a' });
    expect(stored.organizations).toBeUndefined();
  });
});
