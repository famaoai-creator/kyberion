import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  safeSymlinkSync,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  createDistillCandidateRecord,
  distillCandidateRecordPath,
  listDistillCandidateRecordsForTenants,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
  updateDistillCandidateRecord,
} from './distill-candidate-registry.js';
import type { MemoryScopeEnvelope } from './memory-scope.js';
const roots = new Set<string>();
const tenant = () => 'distill-' + randomUUID().slice(0, 8);
function fixture(scope: MemoryScopeEnvelope, id = 'DSC-' + randomUUID()) {
  const row = createDistillCandidateRecord({
    candidate_id: id,
    source_type: 'task_session',
    tier: scope.tier,
    scope,
    title: 'Scoped procedure',
    summary: 'Bounded registry regression',
    status: 'proposed',
    target_kind: 'procedure',
  });
  const file = saveDistillCandidateRecord(row);
  roots.add(
    scope.tier !== 'personal' && scope.tenant_slug
      ? pathResolver.rootResolve(path.join('active/shared/runtime/tenants', scope.tenant_slug))
      : path.dirname(path.dirname(file))
  );
  roots.add(distillCandidateRecordPath(id));
  return { row, file };
}
afterEach(() => {
  for (const root of roots) safeRmSync(root, { recursive: true, force: true });
  roots.clear();
});
describe('exact-scope distill registry', () => {
  it('keeps tenant, sibling organization/project, tier and unscoped lookups separate', () => {
    const tenant_slug = tenant(),
      other = tenant();
    const scope = {
      tier: 'confidential',
      tenant_slug,
      organization_id: 'org-a',
      project_id: 'project-a',
      provenance_refs: ['source:a'],
    } as const;
    const a = fixture({ ...scope, provenance_refs: [...scope.provenance_refs] });
    fixture({ ...scope, provenance_refs: [...scope.provenance_refs], project_id: 'project-b' });
    fixture({ ...scope, provenance_refs: [...scope.provenance_refs], organization_id: 'org-b' });
    fixture({ ...scope, provenance_refs: [...scope.provenance_refs], tenant_slug: other });
    const read = {
      tenantSlugs: [tenant_slug],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
      tierAccess: ['confidential'],
    } as const;
    expect(listDistillCandidateRecordsForTenants(read).map((r) => r.candidate_id)).toEqual([
      a.row.candidate_id,
    ]);
    expect(listDistillCandidateRecordsForTenants({ ...read, tierAccess: ['public'] })).toEqual([]);
    expect(listDistillCandidateRecordsForTenants({ ...read, tenantSlugs: [] })).toEqual([]);
    expect(loadDistillCandidateRecord(a.row.candidate_id)).toBeNull();
    expect(
      loadDistillCandidateRecord(a.row.candidate_id, { ...a.row.scope!, project_id: 'project-b' })
    ).toBeNull();
    expect(
      loadDistillCandidateRecord(a.row.candidate_id, {
        ...a.row.scope!,
        provenance_refs: ['source:b'],
      })
    ).toBeNull();
  });
  it('does not admit missing narrowing context, including parent records', () => {
    const tenant_slug = tenant();
    fixture({ tier: 'confidential', tenant_slug });
    fixture({ tier: 'confidential', tenant_slug, organization_id: 'org-a' });
    const child = fixture({
      tier: 'confidential',
      tenant_slug,
      organization_id: 'org-a',
      project_id: 'project-a',
      mission_id: 'MSN-A',
      task_id: 'TASK-A',
    });
    expect(
      listDistillCandidateRecordsForTenants({
        tenantSlugs: [tenant_slug],
        organizationIds: ['org-a'],
        projectIds: ['project-a'],
        tierAccess: ['confidential'],
      }).map((r) => r.candidate_id)
    ).toEqual([child.row.candidate_id]);
  });
  it('rejects scope erasure/change before any global or sibling write', () => {
    const scope = {
      tier: 'confidential',
      tenant_slug: tenant(),
      organization_id: 'org-a',
      project_id: 'project-a',
    } as const;
    const { row, file } = fixture(scope);
    const original = String(safeReadFile(file, { encoding: 'utf8' }));
    for (const patch of [
      { scope: undefined },
      { scope: { ...scope, project_id: 'project-b' } },
      { scope: { ...scope, tenant_slug: tenant() } },
    ]) {
      expect(() => updateDistillCandidateRecord(row.candidate_id, patch, scope)).toThrow(
        'DISTILL_SCOPE_MISMATCH'
      );
      expect(String(safeReadFile(file, { encoding: 'utf8' }))).toBe(original);
      expect(safeExistsSync(distillCandidateRecordPath(row.candidate_id))).toBe(false);
      if (patch.scope)
        expect(safeExistsSync(distillCandidateRecordPath(row.candidate_id, patch.scope))).toBe(
          false
        );
    }
    expect(
      updateDistillCandidateRecord(row.candidate_id, { status: 'archived' }, scope)?.scope
    ).toEqual(scope);
  });
  it('isolates owner-only personal candidates and does not enumerate them', () => {
    const scope = { tier: 'personal', owner_nhi: 'nhi:' + randomUUID() } as const;
    const { row, file } = fixture(scope);
    expect(file).toContain('/active/personal/owners/');
    expect(loadDistillCandidateRecord(row.candidate_id, scope)?.candidate_id).toBe(
      row.candidate_id
    );
    expect(
      loadDistillCandidateRecord(row.candidate_id, { ...scope, owner_nhi: 'nhi:other' })
    ).toBeNull();
    expect(loadDistillCandidateRecord(row.candidate_id)).toBeNull();
    expect(() => distillCandidateRecordPath(row.candidate_id, { tier: 'personal' })).toThrow(
      'DISTILL_SCOPE_REQUIRED'
    );
    const tenant_slug = tenant();
    const owned = fixture({ tier: 'personal', tenant_slug, owner_nhi: 'nhi:' + randomUUID() });
    expect(owned.file).toContain('/active/personal/owners/');
    expect(loadDistillCandidateRecord(owned.row.candidate_id, owned.row.scope)).not.toBeNull();
    const ownerless = createDistillCandidateRecord({
      ...owned.row,
      scope: { tier: 'personal', tenant_slug },
    });
    expect(() => saveDistillCandidateRecord(ownerless)).toThrow('DISTILL_SCOPE_REQUIRED');
    expect(
      safeExistsSync(
        pathResolver.rootResolve(path.join('active/shared/runtime/tenants', tenant_slug))
      )
    ).toBe(false);
    expect(
      listDistillCandidateRecordsForTenants({
        tenantSlugs: [tenant_slug],
        tierAccess: ['personal', 'confidential'],
      })
    ).toEqual([]);
  });
  it('rejects wrong ID, scope hash, copied path and symlink records', () => {
    const scope = {
      tier: 'confidential',
      tenant_slug: tenant(),
      organization_id: 'org-a',
    } as const;
    const { row, file } = fixture(scope),
      dir = path.dirname(file);
    const read = { tenantSlugs: [scope.tenant_slug], tierAccess: ['confidential'] } as const;
    safeWriteFile(path.join(dir, 'DSC-FORGED.json'), JSON.stringify(row));
    expect(loadDistillCandidateRecord('DSC-FORGED', scope)).toBeNull();
    const wrong = path.join(path.dirname(dir), 'a'.repeat(64));
    safeMkdir(wrong, { recursive: true });
    safeWriteFile(path.join(wrong, row.candidate_id + '.json'), JSON.stringify(row));
    const copied = { ...row, scope: { ...scope, organization_id: 'org-b' } };
    safeWriteFile(path.join(dir, 'DSC-COPIED.json'), JSON.stringify(copied));
    if (process.platform !== 'win32') safeSymlinkSync(file, path.join(dir, 'DSC-LINK.json'));
    expect(listDistillCandidateRecordsForTenants(read).map((r) => r.candidate_id)).toEqual([
      row.candidate_id,
    ]);
    safeWriteFile(file, JSON.stringify({ ...row, candidate_id: 'DSC-ALTERED' }));
    expect(loadDistillCandidateRecord(row.candidate_id, scope)).toBeNull();
    expect(listDistillCandidateRecordsForTenants(read)).toEqual([]);
  });
  it('rejects a symlinked traversal ancestor before reading candidate payloads', () => {
    if (process.platform === 'win32') return;
    const scope = { tier: 'confidential', tenant_slug: tenant() } as const;
    const { row, file } = fixture(scope);
    const root = pathResolver.sharedTmp('distill-ancestor-' + randomUUID());
    roots.add(root);
    const relative = path.join(
      'tenants',
      scope.tenant_slug,
      'distill-candidates',
      'confidential',
      path.basename(path.dirname(file)),
      path.basename(file)
    );
    const actual = path.join(root, 'real', relative);
    safeMkdir(path.dirname(actual), { recursive: true });
    safeWriteFile(actual, JSON.stringify(row));
    safeSymlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
    const original = pathResolver.rootResolve;
    const spy = vi
      .spyOn(pathResolver, 'rootResolve')
      .mockImplementation((value: string) =>
        value.startsWith('active/shared/runtime/tenants/')
          ? path.join(root, 'link', value.slice('active/shared/runtime/'.length))
          : original(value)
      );
    try {
      expect(() =>
        listDistillCandidateRecordsForTenants({
          tenantSlugs: [scope.tenant_slug],
          tierAccess: ['confidential'],
        })
      ).toThrow(/symlink/i);
    } finally {
      spy.mockRestore();
    }
  });
  it('rejects tier downgrade before changing a scoped record', () => {
    const scope = { tier: 'confidential', tenant_slug: tenant() } as const;
    const { row, file } = fixture(scope);
    const before = String(safeReadFile(file, { encoding: 'utf8' }));
    expect(() => updateDistillCandidateRecord(row.candidate_id, { tier: 'public' }, scope)).toThrow(
      'DISTILL_SCOPE_MISMATCH'
    );
    expect(String(safeReadFile(file, { encoding: 'utf8' }))).toBe(before);
    expect(safeExistsSync(distillCandidateRecordPath(row.candidate_id))).toBe(false);
  });

  it('rejects traversal and unknown scope narrowing rather than dropping it', () => {
    expect(() =>
      listDistillCandidateRecordsForTenants({
        tenantSlugs: ['../other'],
        tierAccess: ['confidential'],
      })
    ).toThrow();
    expect(() =>
      listDistillCandidateRecordsForTenants({
        tenantSlugs: [],
        organizationIds: ['../other'],
        tierAccess: ['confidential'],
      })
    ).toThrow();
    expect(() =>
      distillCandidateRecordPath('DSC-SCOPE', {
        tier: 'confidential',
        tenant_slug: tenant(),
        unexpected: 'narrow',
      } as MemoryScopeEnvelope)
    ).toThrow('DISTILL_SCOPE_UNSUPPORTED');
  });
});
