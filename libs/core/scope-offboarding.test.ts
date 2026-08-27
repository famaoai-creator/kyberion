/**
 * AL-04 hermetic tests: scope-linked GC (mission runtime residue) and the
 * tenant/project offboarding verb (dry-run → export → delete, human approval
 * gated, soft-deleted and audited).
 *
 * Everything runs against a temp repo root: secure-io is stubbed onto real
 * fs and path-resolver is repointed, so no test ever touches `active/`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

/**
 * `var`, and created on first access: audit-chain (pulled in transitively by
 * NI-05's governance hook) builds its singleton the moment path-resolver is
 * imported and calls `rootDir()` right then — before any `let` in this file
 * is initialized and before beforeEach runs. A `var` has no TDZ, and the
 * lazy accessor hands that early caller a real directory. Each test then
 * repoints it to a fresh root.
 */
/* eslint-disable no-var */
var rootDirState: string | undefined;
var createdRoots: string[] | undefined;
/* eslint-enable no-var */

function currentRoot(): string {
  if (!rootDirState) {
    rootDirState = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-al04-'));
    (createdRoots ??= []).push(rootDirState);
  }
  return rootDirState;
}

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeReaddir: (dir: string) => actual.readdirSync(dir),
    safeStat: (p: string) => actual.statSync(p),
    safeLstat: (p: string) => actual.lstatSync(p),
    safeUnlinkSync: (p: string) => actual.unlinkSync(p),
    safeRmSync: (p: string, opts: any) => actual.rmSync(p, opts),
    safeExistsSync: (p: string) => actual.existsSync(p),
    safeReadFile: (p: string, opts: any) => actual.readFileSync(p, opts),
    loadJson: (p: string) => JSON.parse(actual.readFileSync(p, 'utf8')),
    safeMkdir: (p: string, opts: any) => actual.mkdirSync(p, opts),
    safeWriteFile: (p: string, data: string) => {
      actual.mkdirSync(path.dirname(p), { recursive: true });
      actual.writeFileSync(p, data);
    },
    safeAppendFileSync: (p: string, data: string) => {
      actual.mkdirSync(path.dirname(p), { recursive: true });
      actual.appendFileSync(p, data);
    },
    safeMoveSync: (src: string, dest: string) => {
      actual.mkdirSync(path.dirname(dest), { recursive: true });
      actual.renameSync(src, dest);
    },
    safeCopyFileSync: (src: string, dest: string) => {
      actual.mkdirSync(path.dirname(dest), { recursive: true });
      actual.copyFileSync(src, dest);
    },
  };
});

vi.mock('./foundation/io.js', () => ({
  getFoundationIo: () => ({
    loadJson: (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')),
    loadJsonIfPresent: (p: string) => {
      if (!fs.existsSync(p)) return null;
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        return null;
      }
    },
    appendFile: (p: string, data: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, data);
    },
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, 'utf8'),
    stat: (p: string) => fs.statSync(p),
    writeFile: (p: string, data: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    },
  }),
  registerFoundationIo: vi.fn(),
}));

vi.mock('./path-resolver.js', () => {
  const resolver = {
    rootDir: () => currentRoot(),
    rootResolve: (rel: string) => (path.isAbsolute(rel) ? rel : path.join(currentRoot(), rel)),
    resolve: (rel: string) => (path.isAbsolute(rel) ? rel : path.join(currentRoot(), rel)),
    shared: (sub = '') => path.join(currentRoot(), 'active', 'shared', sub),
    sharedTmp: (sub = '') => path.join(currentRoot(), 'active', 'shared', 'tmp', sub),
    sharedExports: (sub = '') => path.join(currentRoot(), 'active', 'shared', 'exports', sub),
    sharedLogsAudit: (sub = '') =>
      path.join(currentRoot(), 'active', 'shared', 'logs', 'audit', sub),
    knowledge: (sub = '') => path.join(currentRoot(), 'knowledge', sub),
    findMissionPath: () => null,
  };
  // `pathResolver` (the namespace-style export) is what audit-chain — pulled
  // in transitively by NI-05's governance hook — reads at construction.
  return { ...resolver, pathResolver: resolver };
});

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import {
  collectScopeTargets,
  gcMissionRuntimeResidue,
  INGEST_DEDUP_REGISTRY_REPO_PATH,
  offboardScope,
  OFFBOARDING_EXPORT_SUBDIR,
  verifyScopeOffboarded,
} from './scope-offboarding.js';
import { restoreFromTrash, TRASH_REPO_SUBPATH } from './storage-janitor.js';
import { STORAGE_RETENTION_AUDIT_FILENAME } from './storage-retention-catalog.js';

const MISSION_ID = 'MIS-AL04-TEST';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function abs(repoRelative: string): string {
  return path.join(currentRoot(), ...repoRelative.split('/'));
}

function trashPathOf(repoRelative: string): string {
  return path.join(currentRoot(), ...TRASH_REPO_SUBPATH.split('/'), ...repoRelative.split('/'));
}

function auditEvents(): Array<Record<string, any>> {
  const auditPath = path.join(
    currentRoot(),
    'active',
    'shared',
    'logs',
    'audit',
    STORAGE_RETENTION_AUDIT_FILENAME
  );
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  rootDirState = undefined;
  currentRoot();
});

afterEach(() => {
  if (rootDirState) fs.rmSync(rootDirState, { recursive: true, force: true });
});

afterAll(() => {
  for (const root of createdRoots ?? []) fs.rmSync(root, { recursive: true, force: true });
});

describe('AL-04 mission runtime residue GC', () => {
  function seedResidue(): void {
    writeJson(abs('active/shared/runtime/artifacts/ART-MINE.json'), {
      artifact_id: 'ART-MINE',
      mission_id: MISSION_ID,
      kind: 'doc',
      storage_class: 'repo',
    });
    writeJson(abs('active/shared/runtime/artifacts/ART-OTHER.json'), {
      artifact_id: 'ART-OTHER',
      mission_id: 'MIS-SOMEONE-ELSE',
      kind: 'doc',
      storage_class: 'repo',
    });
    writeJson(abs('active/shared/runtime/task-sessions/ts-mine.json'), {
      session_id: 'ts-mine',
      artifact: { mission_id: MISSION_ID },
    });
    writeJson(abs('active/shared/runtime/task-sessions/ts-top-level.json'), {
      session_id: 'ts-top-level',
      mission_id: MISSION_ID.toLowerCase(),
    });
    writeJson(abs('active/shared/runtime/task-sessions/ts-other.json'), {
      session_id: 'ts-other',
      artifact: { mission_id: 'MIS-SOMEONE-ELSE' },
    });
    writeJson(abs(`active/shared/runtime/session/${MISSION_ID}/state.json`), { ok: true });
    writeJson(abs(`active/shared/runtime/session/${MISSION_ID}-task-7/state.json`), { ok: true });
    writeJson(abs('active/shared/runtime/session/unrelated-session/state.json'), { ok: true });
    // Load-bearing state that must never be touched by a residue sweep.
    writeJson(abs('active/shared/runtime/state/janitor-last-run.json'), { completed_at: 'x' });
  }

  it('collects only this mission’s residue and leaves every other scope alone', () => {
    seedResidue();
    const result = gcMissionRuntimeResidue({ missionId: MISSION_ID, dryRun: true });

    expect(result.status).toBe('gc');
    expect(result.soft_deleted).toEqual([]); // dry run writes nothing
    expect(result.candidates.map((c) => c.path).sort()).toEqual([
      'active/shared/runtime/artifacts/ART-MINE.json',
      `active/shared/runtime/session/${MISSION_ID}`,
      `active/shared/runtime/session/${MISSION_ID}-task-7`,
      'active/shared/runtime/task-sessions/ts-mine.json',
      'active/shared/runtime/task-sessions/ts-top-level.json',
    ]);
    expect(fs.existsSync(abs('active/shared/runtime/artifacts/ART-MINE.json'))).toBe(true);
  });

  it('soft-deletes the residue, audits each removal, and stays idempotent', () => {
    seedResidue();
    const result = gcMissionRuntimeResidue({ missionId: MISSION_ID });

    expect(result.status).toBe('gc');
    expect(result.soft_deleted).toHaveLength(5);
    expect(fs.existsSync(abs('active/shared/runtime/artifacts/ART-MINE.json'))).toBe(false);
    expect(fs.existsSync(abs(`active/shared/runtime/session/${MISSION_ID}/state.json`))).toBe(
      false
    );
    // Other scopes untouched.
    expect(fs.existsSync(abs('active/shared/runtime/artifacts/ART-OTHER.json'))).toBe(true);
    expect(fs.existsSync(abs('active/shared/runtime/task-sessions/ts-other.json'))).toBe(true);
    expect(fs.existsSync(abs('active/shared/runtime/session/unrelated-session/state.json'))).toBe(
      true
    );
    expect(fs.existsSync(abs('active/shared/runtime/state/janitor-last-run.json'))).toBe(true);

    // Recoverable: everything went to the trash, not to /dev/null.
    const trashed = trashPathOf('active/shared/runtime/artifacts/ART-MINE.json');
    expect(fs.existsSync(trashed)).toBe(true);
    expect(restoreFromTrash('active/shared/runtime/artifacts/ART-MINE.json').restored).toBe(true);
    expect(fs.existsSync(abs('active/shared/runtime/artifacts/ART-MINE.json'))).toBe(true);

    const residueAudit = auditEvents().filter((e) => e.event === 'MISSION_RESIDUE_SOFT_DELETE');
    expect(residueAudit).toHaveLength(5);
    expect(residueAudit[0]).toMatchObject({ mission_id: MISSION_ID });
    expect(new Set(residueAudit.map((e) => e.probe))).toEqual(
      new Set(['runtime_artifacts', 'task_sessions', 'session_volatile'])
    );

    // Second run (the restored artifact aside) finds nothing new to reclaim.
    fs.rmSync(abs('active/shared/runtime/artifacts/ART-MINE.json'));
    expect(gcMissionRuntimeResidue({ missionId: MISSION_ID })).toMatchObject({
      status: 'noop',
      soft_deleted: [],
    });
  });

  it('reports an error instead of throwing when the mission id is empty', () => {
    expect(gcMissionRuntimeResidue({ missionId: '  ' })).toMatchObject({ status: 'error' });
  });
});

describe('AL-04 tenant/project offboarding', () => {
  function seedTenant(): void {
    writeJson(abs('active/projects/public/tenant-alpha/workspace/plan.json'), { a: 1 });
    writeJson(abs('active/missions/public/MIS-ALPHA-1/mission-state.json'), {
      mission_id: 'MIS-ALPHA-1',
      tenant_slug: 'tenant-alpha',
      relationships: { project: { project_id: 'proj-x', relationship_type: 'belongs_to' } },
    });
    // Another tenant's mission — must never be swept in.
    writeJson(abs('active/missions/public/MIS-BETA-1/mission-state.json'), {
      mission_id: 'MIS-BETA-1',
      tenant_slug: 'tenant-beta',
    });
  }

  it('discovers the scope’s active/ trees (project workspace + declaring missions)', () => {
    seedTenant();
    expect(collectScopeTargets('tenant', 'tenant-alpha')).toEqual([
      { path: 'active/projects/public/tenant-alpha', kind: 'project_tree' },
      { path: 'active/missions/public/MIS-ALPHA-1', kind: 'mission_tree' },
    ]);
    expect(collectScopeTargets('project', 'proj-x')).toEqual([
      { path: 'active/missions/public/MIS-ALPHA-1', kind: 'mission_tree' },
    ]);
    expect(collectScopeTargets('tenant', 'tenant-unknown')).toEqual([]);
  });

  it('discovers tenant and project physical namespaces outside the mission tree', () => {
    writeJson(
      abs(
        'active/shared/runtime/media-generation/schedules/tenants/tenant-alpha/organizations/org-a/projects/proj-x/monthly.json'
      ),
      { schedule_id: 'monthly' }
    );
    writeJson(
      abs(
        'active/shared/coordination/channels/discord/tenants/tenant-alpha/organizations/org-a/projects/proj-x/outbox/msg.json'
      ),
      { message_id: 'msg' }
    );
    writeJson(
      abs('active/shared/runtime/presence/tenants/tenant-alpha/notifications/presence.json'),
      { notification_id: 'presence' }
    );

    expect(collectScopeTargets('tenant', 'tenant-alpha')).toEqual([
      {
        path: 'active/shared/runtime/media-generation/schedules/tenants/tenant-alpha',
        kind: 'tenant_physical_namespace',
      },
      {
        path: 'active/shared/coordination/channels/discord/tenants/tenant-alpha',
        kind: 'tenant_physical_namespace',
      },
      {
        path: 'active/shared/runtime/presence/tenants/tenant-alpha',
        kind: 'tenant_physical_namespace',
      },
    ]);
    expect(
      collectScopeTargets('project', 'proj-x', {
        tenantSlug: 'tenant-alpha',
        organizationId: 'org-a',
      })
    ).toEqual([
      {
        path: 'active/shared/runtime/media-generation/schedules/tenants/tenant-alpha/organizations/org-a/projects/proj-x',
        kind: 'project_physical_namespace',
      },
      {
        path: 'active/shared/coordination/channels/discord/tenants/tenant-alpha/organizations/org-a/projects/proj-x',
        kind: 'project_physical_namespace',
      },
    ]);
  });

  it('fails closed for overlapping project namespaces and unsafe scope IDs', () => {
    writeJson(
      abs(
        'active/shared/runtime/media-generation/schedules/tenants/tenant-a/organizations/org-a/projects/proj-overlap/job.json'
      ),
      { schedule_id: 'job' }
    );
    writeJson(
      abs(
        'active/shared/runtime/media-generation/schedules/tenants/tenant-b/organizations/org-b/projects/proj-overlap/job.json'
      ),
      { schedule_id: 'job' }
    );

    expect(() => collectScopeTargets('project', 'proj-overlap')).toThrow(
      'PROJECT_PHYSICAL_NAMESPACE_AMBIGUOUS'
    );
    expect(offboardScope({ scopeType: 'tenant', scopeId: '../outside' })).toMatchObject({
      status: 'error',
    });
  });

  it('applies tenant and organization lineage to project workspaces and missions', () => {
    writeJson(abs('active/projects/confidential/tenant-a/proj-shared/state/project-state.json'), {
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
    });
    writeJson(abs('active/projects/confidential/tenant-b/proj-shared/state/project-state.json'), {
      tenant_slug: 'tenant-b',
      organization_id: 'org-b',
    });
    writeJson(abs('active/missions/confidential/MIS-PROJ-A/mission-state.json'), {
      mission_id: 'MIS-PROJ-A',
      tenant_slug: 'tenant-a',
      organization_id: 'org-a',
      relationships: { project: { project_id: 'proj-shared', relationship_type: 'belongs_to' } },
    });
    writeJson(abs('active/missions/confidential/MIS-PROJ-B/mission-state.json'), {
      mission_id: 'MIS-PROJ-B',
      tenant_slug: 'tenant-b',
      organization_id: 'org-b',
      relationships: { project: { project_id: 'proj-shared', relationship_type: 'belongs_to' } },
    });

    expect(() => collectScopeTargets('project', 'proj-shared')).toThrow(
      'PROJECT_WORKSPACE_AMBIGUOUS'
    );
    expect(
      collectScopeTargets('project', 'proj-shared', {
        tenantSlug: 'tenant-a',
        organizationId: 'org-a',
      })
    ).toEqual([
      { path: 'active/projects/confidential/tenant-a/proj-shared', kind: 'project_tree' },
      { path: 'active/missions/confidential/MIS-PROJ-A', kind: 'mission_tree' },
    ]);
  });

  it('refuses to claim an unscoped data-vault entry during project offboarding', () => {
    writeJson(abs('active/shared/data-vault/shared-project.json'), {
      sourceType: 'confluence',
      key: 'shared',
      projectId: 'proj-shared',
      tier: 'confidential',
    });

    expect(() =>
      collectScopeTargets('project', 'proj-shared', {
        tenantSlug: 'tenant-a',
        organizationId: 'org-a',
      })
    ).toThrow('PROJECT_DATA_VAULT_AMBIGUOUS');
  });

  it('exports and soft-deletes physical namespaces during tenant offboarding', () => {
    const scheduleRoot = 'active/shared/runtime/media-generation/schedules/tenants/tenant-alpha';
    const channelRoot = 'active/shared/coordination/channels/discord/tenants/tenant-alpha';
    writeJson(abs(`${scheduleRoot}/monthly.json`), { schedule_id: 'monthly' });
    writeJson(abs(`${channelRoot}/outbox/msg.json`), { message_id: 'msg' });

    const result = offboardScope({
      scopeType: 'tenant',
      scopeId: 'tenant-alpha',
      mode: 'execute',
      approval: { approved_by: 'human:test', purpose: 'physical namespace test' },
      nowIso: '2026-08-16T00:00:00.000Z',
    });

    expect(result.status).toBe('offboarded');
    expect(result.soft_deleted).toEqual(expect.arrayContaining([scheduleRoot, channelRoot]));
    expect(fs.existsSync(abs(`${scheduleRoot}/monthly.json`))).toBe(false);
    expect(fs.existsSync(abs(`${channelRoot}/outbox/msg.json`))).toBe(false);
    expect(result.verification).toEqual({ clean: true, leftovers: [] });
    expect(fs.existsSync(trashPathOf(scheduleRoot))).toBe(true);
    expect(fs.existsSync(trashPathOf(channelRoot))).toBe(true);
  });

  it('dry run reports the targets, writes nothing, and needs no approval', () => {
    seedTenant();
    const result = offboardScope({ scopeType: 'tenant', scopeId: 'tenant-alpha' });

    expect(result.status).toBe('dry_run');
    expect(result.targets).toHaveLength(2);
    expect(result.soft_deleted).toEqual([]);
    expect(result.export_path).toBeUndefined();
    expect(fs.existsSync(abs('active/projects/public/tenant-alpha/workspace/plan.json'))).toBe(
      true
    );
    expect(auditEvents().map((e) => e.event)).toContain('SCOPE_OFFBOARD_DRY_RUN');
  });

  it('refuses to delete without a human approval (fail-closed) and audits the denial', () => {
    seedTenant();
    const result = offboardScope({
      scopeType: 'tenant',
      scopeId: 'tenant-alpha',
      mode: 'execute',
    });

    expect(result.status).toBe('approval_required');
    expect(result.soft_deleted).toEqual([]);
    expect(fs.existsSync(abs('active/projects/public/tenant-alpha/workspace/plan.json'))).toBe(
      true
    );
    expect(auditEvents().map((e) => e.event)).toContain('SCOPE_OFFBOARD_DENIED');

    // A half-filled approval is no approval.
    expect(
      offboardScope({
        scopeType: 'tenant',
        scopeId: 'tenant-alpha',
        mode: 'execute',
        approval: { approved_by: 'operator', purpose: '   ' },
      }).status
    ).toBe('approval_required');
  });

  it('exports before deleting, soft-deletes the originals, and audits every step', () => {
    seedTenant();
    const result = offboardScope({
      scopeType: 'tenant',
      scopeId: 'tenant-alpha',
      mode: 'execute',
      approval: {
        approved_by: 'operator@example',
        purpose: 'contract ended — tenant offboarding',
        approved_at: '2026-07-26T00:00:00.000Z',
      },
      nowIso: '2026-07-26T01:02:03.000Z',
    });

    expect(result.status).toBe('offboarded');
    expect(result.export_path).toBe(
      `active/shared/exports/${OFFBOARDING_EXPORT_SUBDIR}/tenant-tenant-alpha-2026-07-26T01-02-03-000Z`
    );
    expect(result.soft_deleted).toEqual([
      'active/projects/public/tenant-alpha',
      'active/missions/public/MIS-ALPHA-1',
    ]);

    // Export holds a full copy, keyed by the original repo-relative path.
    const exported = abs(
      `${result.export_path}/active/projects/public/tenant-alpha/workspace/plan.json`
    );
    expect(JSON.parse(fs.readFileSync(exported, 'utf8'))).toEqual({ a: 1 });
    const manifest = JSON.parse(
      fs.readFileSync(abs(`${result.export_path}/manifest.json`), 'utf8')
    );
    expect(manifest).toMatchObject({
      scope_type: 'tenant',
      scope_id: 'tenant-alpha',
      approval: {
        approved_by: 'operator@example',
        approved_at: '2026-07-26T00:00:00.000Z',
        purpose: 'contract ended — tenant offboarding',
      },
    });

    // Originals gone from active/, recoverable from the trash.
    expect(fs.existsSync(abs('active/projects/public/tenant-alpha'))).toBe(false);
    expect(fs.existsSync(abs('active/missions/public/MIS-ALPHA-1'))).toBe(false);
    expect(
      fs.existsSync(trashPathOf('active/projects/public/tenant-alpha/workspace/plan.json'))
    ).toBe(true);
    // The other tenant is untouched.
    expect(fs.existsSync(abs('active/missions/public/MIS-BETA-1/mission-state.json'))).toBe(true);

    const events = auditEvents().map((e) => e.event);
    expect(events).toContain('SCOPE_OFFBOARD_EXPORTED');
    expect(events.filter((e) => e === 'SCOPE_OFFBOARD_SOFT_DELETE')).toHaveLength(2);
    const deleteRecord = auditEvents().find((e) => e.event === 'SCOPE_OFFBOARD_SOFT_DELETE');
    expect(deleteRecord).toMatchObject({
      scope_type: 'tenant',
      scope_id: 'tenant-alpha',
      approved_by: 'operator@example',
      purpose: 'contract ended — tenant offboarding',
    });

    // Idempotent: nothing left to offboard.
    expect(
      offboardScope({
        scopeType: 'tenant',
        scopeId: 'tenant-alpha',
        mode: 'execute',
        approval: { approved_by: 'operator@example', purpose: 'retry' },
      }).status
    ).toBe('not_found');
  });

  it('restores an offboarded tree from the trash (soft-delete grace)', () => {
    seedTenant();
    offboardScope({
      scopeType: 'tenant',
      scopeId: 'tenant-alpha',
      mode: 'execute',
      approval: { approved_by: 'operator', purpose: 'mistake incoming' },
    });

    expect(restoreFromTrash('active/projects/public/tenant-alpha').restored).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(abs('active/projects/public/tenant-alpha/workspace/plan.json'), 'utf8')
      )
    ).toEqual({
      a: 1,
    });
  });

  it('reports not_found for an unknown scope and error for a blank id', () => {
    expect(offboardScope({ scopeType: 'project', scopeId: 'nope' })).toMatchObject({
      status: 'not_found',
    });
    expect(offboardScope({ scopeType: 'project', scopeId: '' })).toMatchObject({ status: 'error' });
  });
});

describe('DA-08 tenant offboarding — ledger, cursors, dedup registry, data vault', () => {
  const TENANT = 'tenant-alpha';
  const KNOWLEDGE_ROOT = `knowledge/confidential/${TENANT}`;
  const ALPHA_HASH = 'a'.repeat(64);
  const ALPHA_HASH_2 = 'c'.repeat(64);
  const BETA_HASH = 'b'.repeat(64);

  function writeJsonl(repoRelative: string, lines: unknown[]): void {
    const filePath = abs(repoRelative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`
    );
  }

  function registryLines(): string[] {
    return fs
      .readFileSync(abs(INGEST_DEDUP_REGISTRY_REPO_PATH), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
  }

  function seedIngestResidue(): void {
    // Tenant knowledge tree with the DA-05 asset ledger inside.
    fs.mkdirSync(abs(`${KNOWLEDGE_ROOT}/reports`), { recursive: true });
    fs.writeFileSync(abs(`${KNOWLEDGE_ROOT}/reports/q1.md`), '# Q1');
    writeJsonl(`${KNOWLEDGE_ROOT}/_ledger/assets.jsonl`, [
      {
        asset_id: 'ing-alpha1',
        source_system: 'confluence',
        source_id: 'PAGE-1',
        content_sha256: ALPHA_HASH,
        target_path: `${KNOWLEDGE_ROOT}/reports/q1.md`,
        version: 1,
        status: 'active',
      },
    ]);
    // Another tenant's knowledge tree — must survive untouched.
    fs.mkdirSync(abs('knowledge/confidential/tenant-beta'), { recursive: true });
    fs.writeFileSync(abs('knowledge/confidential/tenant-beta/x.md'), '# Beta');
    // Sync cursors + quota counters for both tenants.
    writeJson(abs(`active/shared/runtime/ingest-cursors/${TENANT}/confluence.json`), { c: 1 });
    writeJson(abs('active/shared/runtime/ingest-cursors/tenant-beta/confluence.json'), { c: 2 });
    writeJson(abs(`active/shared/runtime/ingest/quota/${TENANT}/2026-07-28.json`), {
      files: 3,
      bytes: 100,
    });
    // Shared dedup registry: two alpha lines (one by ledger hash, one only by
    // landing-path prefix), one beta line, one corrupt line.
    writeJsonl(INGEST_DEDUP_REGISTRY_REPO_PATH, [
      { content_sha256: ALPHA_HASH, source_system: 'confluence', source_id: 'PAGE-1' },
      { content_sha256: ALPHA_HASH_2, target_path: `${KNOWLEDGE_ROOT}/reports/q2.md` },
      { content_sha256: BETA_HASH, target_path: 'knowledge/confidential/tenant-beta/x.md' },
      '{corrupt line',
    ]);
    // Data-vault entries keyed by projectId.
    writeJson(abs('active/shared/data-vault/alpha-entry.json'), {
      sourceType: 'confluence',
      key: 'k1',
      projectId: TENANT,
      tier: 'confidential',
      data: { secret: 1 },
    });
    writeJson(abs('active/shared/data-vault/other-entry.json'), {
      sourceType: 'confluence',
      key: 'k2',
      projectId: 'someone-else',
      tier: 'confidential',
      data: { keep: true },
    });
    // Classic active/ residue so the pre-DA-08 flow is exercised together.
    writeJson(abs(`active/projects/public/${TENANT}/workspace/plan.json`), { a: 1 });
  }

  it('dry run surfaces every residue class and writes nothing', () => {
    seedIngestResidue();
    const result = offboardScope({ scopeType: 'tenant', scopeId: TENANT });

    expect(result.status).toBe('dry_run');
    expect(result.targets).toEqual(
      expect.arrayContaining([
        { path: `active/projects/public/${TENANT}`, kind: 'project_tree' },
        { path: KNOWLEDGE_ROOT, kind: 'tenant_knowledge_tree' },
        { path: `active/shared/runtime/ingest-cursors/${TENANT}`, kind: 'ingest_cursors_tree' },
        { path: `active/shared/runtime/ingest/quota/${TENANT}`, kind: 'ingest_cursors_tree' },
        { path: 'active/shared/data-vault/alpha-entry.json', kind: 'data_vault_entry' },
      ])
    );
    expect(result.targets.map((t) => t.path)).not.toContain(
      'active/shared/data-vault/other-entry.json'
    );
    expect(result.dedup_registry).toEqual({ matched: 2, removed: 0 });

    // Nothing changed on disk.
    expect(fs.existsSync(abs(`${KNOWLEDGE_ROOT}/_ledger/assets.jsonl`))).toBe(true);
    expect(fs.existsSync(abs(`active/shared/runtime/ingest-cursors/${TENANT}`))).toBe(true);
    expect(fs.existsSync(abs('active/shared/data-vault/alpha-entry.json'))).toBe(true);
    expect(registryLines()).toHaveLength(4);

    // And the standalone verification agrees there are still traces.
    const verification = verifyScopeOffboarded('tenant', TENANT);
    expect(verification.clean).toBe(false);
    expect(verification.leftovers.length).toBeGreaterThan(0);
  });

  it('execute leaves zero trace — knowledge, ledger, cursors, quota, dedup lines, vault — all audited', () => {
    seedIngestResidue();
    const result = offboardScope({
      scopeType: 'tenant',
      scopeId: TENANT,
      mode: 'execute',
      approval: { approved_by: 'operator@example', purpose: 'contract ended' },
      nowIso: '2026-07-28T01:02:03.000Z',
    });

    expect(result.status).toBe('offboarded');

    // DA-08 acceptance: no trace of the tenant remains anywhere.
    expect(result.verification).toEqual({ clean: true, leftovers: [] });
    expect(fs.existsSync(abs(KNOWLEDGE_ROOT))).toBe(false);
    expect(fs.existsSync(abs(`active/shared/runtime/ingest-cursors/${TENANT}`))).toBe(false);
    expect(fs.existsSync(abs(`active/shared/runtime/ingest/quota/${TENANT}`))).toBe(false);
    expect(fs.existsSync(abs('active/shared/data-vault/alpha-entry.json'))).toBe(false);

    // The dedup registry kept exactly the other tenant's line + the corrupt line.
    const kept = registryLines();
    expect(kept).toHaveLength(2);
    expect(kept.some((line) => line.includes(BETA_HASH))).toBe(true);
    expect(kept.some((line) => line.includes('{corrupt line'))).toBe(true);
    expect(kept.some((line) => line.includes(ALPHA_HASH))).toBe(false);
    expect(result.dedup_registry).toMatchObject({ matched: 2, removed: 2 });

    // Everything else survives.
    expect(fs.existsSync(abs('knowledge/confidential/tenant-beta/x.md'))).toBe(true);
    expect(fs.existsSync(abs('active/shared/runtime/ingest-cursors/tenant-beta'))).toBe(true);
    expect(fs.existsSync(abs('active/shared/data-vault/other-entry.json'))).toBe(true);

    // Export-before-delete: knowledge (incl. ledger), and the removed
    // dedup-registry lines as a verbatim JSONL copy.
    const exported = abs(`${result.export_path}/${KNOWLEDGE_ROOT}/_ledger/assets.jsonl`);
    expect(fs.existsSync(exported)).toBe(true);
    const removedCopy = fs.readFileSync(
      abs(`${result.export_path}/dedup-registry-removed.jsonl`),
      'utf8'
    );
    expect(removedCopy).toContain(ALPHA_HASH);
    expect(removedCopy).toContain(ALPHA_HASH_2);

    // Every purge audited: soft-deletes per target, dedup prune, verification.
    const events = auditEvents();
    const softDeletes = events.filter((e) => e.event === 'SCOPE_OFFBOARD_SOFT_DELETE');
    expect(softDeletes.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        KNOWLEDGE_ROOT,
        `active/shared/runtime/ingest-cursors/${TENANT}`,
        `active/shared/runtime/ingest/quota/${TENANT}`,
        'active/shared/data-vault/alpha-entry.json',
      ])
    );
    expect(events.find((e) => e.event === 'SCOPE_OFFBOARD_DEDUP_REGISTRY_PRUNE')).toMatchObject({
      scope_id: TENANT,
      removed_lines: 2,
      kept_lines: 2,
      approved_by: 'operator@example',
    });
    expect(events.find((e) => e.event === 'SCOPE_OFFBOARD_VERIFIED')).toMatchObject({
      scope_id: TENANT,
      clean: true,
    });

    // Idempotent: a second execute finds nothing.
    expect(
      offboardScope({
        scopeType: 'tenant',
        scopeId: TENANT,
        mode: 'execute',
        approval: { approved_by: 'operator@example', purpose: 'retry' },
      }).status
    ).toBe('not_found');
  });

  it('refuses to touch the residue without approval (fail-closed carries over)', () => {
    seedIngestResidue();
    const result = offboardScope({ scopeType: 'tenant', scopeId: TENANT, mode: 'execute' });
    expect(result.status).toBe('approval_required');
    expect(fs.existsSync(abs(`${KNOWLEDGE_ROOT}/_ledger/assets.jsonl`))).toBe(true);
    expect(registryLines()).toHaveLength(4);
  });
});
