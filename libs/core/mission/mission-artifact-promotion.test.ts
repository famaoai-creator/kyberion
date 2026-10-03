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
let projects: typeof import('../project/project-registry.js');

function registerProject(
  projectId: string,
  tier: 'public' | 'confidential',
  tenantSlug?: string
): void {
  projects.saveProjectRecord({
    project_id: projectId,
    name: projectId,
    summary: 'Promotion test project.',
    status: 'active',
    tier,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
  } as Parameters<typeof projects.saveProjectRecord>[0]);
}

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
    // mkdtemp creates the directory atomically with a private 0700 mode.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyb-artifact-promotion-'));
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
    projects = await import('../project/project-registry.js');
    registerProject('proj-a', 'public');
    registerProject('proj-conf', 'confidential', 'acme');
    // Owned writes are placed by the owner's record: the missions and the
    // digest's organizations exist.
    for (const missionId of [
      'MSN-PROMOTE-A',
      'MSN-PROMOTE-SCOPE',
      'MSN-PROMOTE-REPUB',
      'MSN-PROMOTE-FORGED',
    ]) {
      const dir = path.join(tmpRoot, 'active/missions', missionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'mission-state.json'),
        JSON.stringify({
          mission_id: missionId,
          tier: 'public',
          status: 'completed',
          execution_mode: 'local',
          priority: 1,
          assigned_persona: 'worker',
          confidence_score: 1,
          git: { branch: 'm', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
          history: [],
        })
      );
    }
    for (const [tier, tenant, org] of [
      ['confidential', 'acme', 'org-a'],
      ['public', 'shared', 'org-b'],
    ]) {
      fs.mkdirSync(path.join(tmpRoot, 'active/organizations', tier, tenant, org, 'state'), {
        recursive: true,
      });
    }
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
      metadata: expect.objectContaining({
        tier: 'public',
        scope_kind: 'project',
        promoted_from_mission: missionId,
        // The mission tree moves to the archive right after promotion.
        promoted_from: 'active/archive/missions/MSN-PROMOTE-A/artifacts/report/summary.md',
      }),
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

  it('places by the project record and refuses a mission outside its scope', () => {
    const missionId = 'MSN-PROMOTE-SCOPE';
    const report = store.writeScopedArtifact({
      scope: { mission: missionId },
      tier: 'public',
      artifact_class: 'report',
      name: 'public.md',
      content: 'x',
      publish: { kind: 'report' },
    });
    // A public mission linked to a confidential tenant project must not
    // promote: the record would otherwise surface in another tier/tenant.
    const result = promotion.promoteMissionArtifactsToProject({
      missionId,
      missionDir: pathResolver.missionDir(missionId, 'public'),
      state: missionState(missionId, 'proj-conf'),
    });
    expect(result).toMatchObject({ status: 'skipped', reason: 'scope_mismatch', promoted: [] });
    expect(records.loadArtifactRecord(report.artifact_id as string)?.path).toBe(
      report.repo_relative_path
    );
    expect(
      promotion.promoteMissionArtifactsToProject({
        missionId,
        missionDir: pathResolver.missionDir(missionId, 'public'),
        state: missionState(missionId, 'proj-missing'),
      })
    ).toMatchObject({ status: 'skipped', reason: 'project_not_found' });
  });

  it('copies a re-published path once and re-points every record', () => {
    const missionId = 'MSN-PROMOTE-REPUB';
    const write = () =>
      store.writeScopedArtifact({
        scope: { mission: missionId },
        tier: 'public',
        artifact_class: 'report',
        name: 'weekly.md',
        content: 'v',
        publish: { kind: 'report' },
      });
    const first = write();
    const second = write();
    const result = promotion.promoteMissionArtifactsToProject({
      missionId,
      missionDir: pathResolver.missionDir(missionId, 'public'),
      state: missionState(missionId, 'proj-a'),
    });
    expect(result.status).toBe('promoted');
    expect(new Set(result.promoted.map((entry) => entry.to)).size).toBe(1);
    expect(result.promoted.map((entry) => entry.artifact_id).sort()).toEqual(
      [first.artifact_id, second.artifact_id].sort()
    );
  });

  it('never copies an index row that points outside the mission artifacts tree', () => {
    const missionId = 'MSN-PROMOTE-FORGED';
    const foreign = store.writeScopedArtifact({
      scope: { project: 'proj-conf', tenant: 'acme' },
      tier: 'confidential',
      artifact_class: 'report',
      name: 'secret.md',
      content: 'secret',
    });
    // Seed the mission index with a forged row and a record for that path.
    store.writeScopedArtifact({
      scope: { mission: missionId },
      tier: 'public',
      artifact_class: 'report',
      name: 'seed.md',
      content: 'seed',
    });
    const indexPath = path.join(
      pathResolver.missionDir(missionId, 'public'),
      'artifacts',
      'artifacts-index.jsonl'
    );
    fs.appendFileSync(
      indexPath,
      `${JSON.stringify({
        name: 'secret.md',
        artifact_class: 'report',
        path: foreign.repo_relative_path,
        scope: { mission: missionId },
        scope_kind: 'mission',
        written_at: new Date().toISOString(),
      })}\n`
    );
    records.saveArtifactRecord(
      records.createArtifactRecord({
        kind: 'report',
        storage_class: 'artifact_store',
        path: foreign.repo_relative_path,
        mission_id: missionId,
      })
    );
    const result = promotion.promoteMissionArtifactsToProject({
      missionId,
      missionDir: pathResolver.missionDir(missionId, 'public'),
      state: missionState(missionId, 'proj-a'),
    });
    expect(result.promoted).toEqual([]);
    expect(result.failed[0]?.error).toMatch(/outside the mission artifacts tree/);
    expect(
      fs.existsSync(
        path.join(
          tmpRoot,
          'active/projects/public/shared/proj-a/artifacts/report/missions',
          missionId,
          'secret.md'
        )
      )
    ).toBe(false);
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
    // A same-day re-run updates the same record instead of adding one.
    const rerun = digestArtifacts.persistOrganizationDigest(digest);
    expect(rerun.persisted.map((item) => item.artifact_id)).toEqual(
      result.persisted.map((item) => item.artifact_id)
    );
    expect(result.persisted[0]?.artifact_id).toMatch(/^ART-ORGDIGEST-20261002-[0-9A-F]{20}$/);
    expect(result.persisted[0]?.artifact_id).not.toBe(result.persisted[1]?.artifact_id);

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
