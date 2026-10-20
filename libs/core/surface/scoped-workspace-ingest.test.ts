import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  safeCopyFileSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { withExecutionContext } from '../authority.js';

const checkout = process.cwd();
const fixtureRoot = path.join(checkout, 'active/shared/tmp/workspace-ingest-' + randomUUID());
let ingest: typeof import('./scoped-workspace-ingest.js');
let scope: typeof import('./workspace-scope.js');
let records: typeof import('../workforce/artifact-record.js');
let registry: typeof import('../workforce/artifact-registry.js');
beforeAll(async () => {
  withExecutionContext('ecosystem_architect', () => {
    const copy = (source: string, target: string) => {
      if (safeLstat(source).isDirectory()) {
        safeMkdir(target, { recursive: true });
        for (const name of safeReaddir(source))
          copy(path.join(source, name), path.join(target, name));
      } else safeCopyFileSync(source, target);
    };
    safeMkdir(fixtureRoot, { recursive: true });
    safeWriteFile(path.join(fixtureRoot, 'package.json'), '{}');
    copy(
      path.join(checkout, 'knowledge/product/schemas'),
      path.join(fixtureRoot, 'knowledge/product/schemas')
    );
    safeMkdir(path.join(fixtureRoot, 'knowledge/product/governance'), { recursive: true });
    for (const file of [
      'agent-policies.yaml',
      'knowledge-sync-rules.json',
      'security-policy.json',
      'role-assumption-policy.json',
      'authority-role-index.json',
    ])
      safeCopyFileSync(
        path.join(checkout, 'knowledge/product/governance', file),
        path.join(fixtureRoot, 'knowledge/product/governance', file)
      );
    safeMkdir(path.join(fixtureRoot, 'knowledge/personal/tenants'), { recursive: true });
    safeWriteFile(
      path.join(fixtureRoot, 'knowledge/personal/tenants/workspace-tenant.json'),
      JSON.stringify({
        tenant_slug: 'workspace-tenant',
        display_name: 'Private profile name',
        status: 'active',
        assigned_role: 'owner',
      })
    );
  });
  vi.stubEnv('KYBERION_ROOT', fixtureRoot);
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.resetModules();
  ingest = await import('./scoped-workspace-ingest.js');
  scope = await import('./workspace-scope.js');
  records = await import('../workforce/artifact-record.js');
  registry = await import('../workforce/artifact-registry.js');
  const { saveProjectRecord } = await import('../project/project-registry.js');
  saveProjectRecord({
    project_id: 'project-workspace',
    name: 'Workspace',
    summary: 'Isolated context fixture',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'workspace-tenant',
    organization_id: 'workspace-org',
  });
  for (const tier of ['public', 'personal'] as const)
    saveProjectRecord({
      project_id: `project-${tier}`,
      name: tier,
      summary: 'Untentanted context fixture',
      status: 'active',
      tier,
    });
});
afterAll(() => {
  vi.unstubAllEnvs();
  withExecutionContext('ecosystem_architect', () =>
    safeRmSync(fixtureRoot, { recursive: true, force: true })
  );
});

it('resolves a granted tenant under the actual readonly surface role without exposing its personal profile', async () => {
  const authority = await import('../authority.js');
  const { readTenantProfile } = await import('../organization/tenant-registry.js');
  const secure = await import('../secure-io.js');
  vi.stubEnv('SYSTEM_ROLE', 'chronos_mirror_v2');
  try {
    authority.withExecutionContext('chronos_operator', () => {
      expect(() => readTenantProfile('workspace-tenant')).toThrow();
      const resolved = scope.resolveWorkspaceScope(
        {
          tenantSlugs: ['workspace-tenant'],
          organizationIds: 'all',
          projectIds: 'all',
          tierAccess: ['confidential'],
        },
        { tenant_slug: 'workspace-tenant' }
      );
      expect(resolved.selection).toEqual({ kind: 'tenant', tenant_slug: 'workspace-tenant' });
      expect(JSON.stringify(resolved)).not.toContain('Private profile name');
      const viewer = {
        tenantSlugs: ['workspace-tenant'],
        organizationIds: 'all' as const,
        projectIds: 'all' as const,
        tierAccess: ['confidential' as const],
      };
      expect(scope.listWorkspaceTenantOptions(viewer)).toEqual([
        { slug: 'workspace-tenant', displayName: 'workspace-tenant' },
      ]);
      expect(scope.listWorkspaceTenantOptions({ ...viewer, tenantSlugs: 'all' })).toEqual([
        { slug: 'workspace-tenant', displayName: 'workspace-tenant' },
      ]);
      expect(() =>
        authority.withExecutionContext('workspace_tenant_registry_index_reader', () =>
          secure.safeReadFile(
            path.join(fixtureRoot, 'knowledge/personal/tenants/workspace-tenant.json'),
            { encoding: 'utf8' }
          )
        )
      ).toThrow();
      expect(() =>
        scope.resolveWorkspaceScope(
          {
            tenantSlugs: ['workspace-tenant'],
            organizationIds: 'all',
            projectIds: 'all',
            tierAccess: ['confidential'],
          },
          { tenant_slug: 'other-tenant' }
        )
      ).toThrow();
    });
  } finally {
    vi.unstubAllEnvs();
    vi.stubEnv('KYBERION_ROOT', fixtureRoot);
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
  }
});
function workspace() {
  return scope.resolveWorkspaceScope(
    {
      tenantSlugs: ['workspace-tenant'],
      organizationIds: ['workspace-org'],
      projectIds: ['project-workspace'],
      tierAccess: ['confidential'],
    },
    { project_id: 'project-workspace' },
    {
      readTenant: (tenant_slug) => ({ tenant_slug }),
      readProject: () => ({
        project_id: 'project-workspace',
        tenant_slug: 'workspace-tenant',
        organization_id: 'workspace-org',
        tier: 'confidential',
      }),
      readOrganization: () => ({
        organization_id: 'workspace-org',
        tenant_slug: 'workspace-tenant',
        tier: 'confidential',
      }),
      readOperation: () => null,
    }
  );
}
describe('scoped workspace document intake using the real reader, PII gate and artifact stores', () => {
  it('publishes durable project context with matching record and reusable ownership registry', async () => {
    const result = await ingest.ingestScopedWorkspaceDocument({
      workspace: workspace(),
      fileName: 'context.md',
      bytes: Buffer.from('# Context\nA reusable procedure.'),
      actorId: 'user:uploader',
    });
    expect(result.outcome).toBe('committed');
    expect(result.artifact_id).toBeTruthy();
    const record = records.loadArtifactRecord(result.artifact_id!)!;
    expect(record).toMatchObject({
      project_id: 'project-workspace',
      tenant_slug: 'workspace-tenant',
      organization_id: 'workspace-org',
      kind: 'document',
      storage_class: 'artifact_store',
    });
    expect(record.metadata).toMatchObject({
      workspace_context: true,
      source_sha256: result.source_sha256,
      ingested_by: 'user:uploader',
      tier: 'confidential',
    });
    expect(
      registry.findReusableArtifactOwnershipRecord({
        projectId: 'project-workspace',
        kind: 'document',
      })?.artifact_id
    ).toBe(record.artifact_id);
    expect(safeReadFile(path.join(fixtureRoot, record.path!), { encoding: 'utf8' })).toContain(
      'A reusable procedure.'
    );
    expect(record.path).not.toMatch(/^knowledge\//);
  });
  it.each(['public', 'personal'] as const)(
    'keeps an untenanted %s project in its actual owner scope',
    async (tier) => {
      const project_id = `project-${tier}`;
      const resolved = scope.resolveWorkspaceScope(
        { tenantSlugs: 'all', organizationIds: 'all', projectIds: 'all', tierAccess: [tier] },
        { project_id },
        {
          readTenant: () => null,
          readOrganization: () => null,
          readOperation: () => null,
          readProject: () => ({ project_id, tier }),
        }
      );
      const result = await ingest.ingestScopedWorkspaceDocument({
        workspace: resolved,
        fileName: `${tier}.md`,
        bytes: Buffer.from(`# ${tier}\nA reusable procedure.`),
        actorId: 'user:uploader',
      });
      const record = records.loadArtifactRecord(result.artifact_id!)!;
      expect(record.project_id).toBe(project_id);
      expect(record.tenant_slug).toBeUndefined();
      expect(record.organization_id).toBeUndefined();
      expect(record.metadata?.tier).toBe(tier);
      expect(result.scope).toEqual({ tier, project_id });
    }
  );
  it('does not publish on dry run and blocks secrets before any durable write', async () => {
    const count = registry.listArtifactOwnershipRecords().length;
    const dry = await ingest.ingestScopedWorkspaceDocument({
      workspace: workspace(),
      fileName: 'preview.txt',
      bytes: Buffer.from('Preview only.'),
      actorId: 'user:uploader',
      dryRun: true,
    });
    expect(dry.outcome).toBe('would_commit');
    expect(dry).not.toHaveProperty('artifact_id');
    await expect(
      ingest.ingestScopedWorkspaceDocument({
        workspace: workspace(),
        fileName: 'blocked.txt',
        bytes: Buffer.from('-----BEGIN PRIVATE KEY-----'),
        actorId: 'user:uploader',
      })
    ).rejects.toThrow('WORKSPACE_INGEST_BLOCKED');
    expect(registry.listArtifactOwnershipRecords()).toHaveLength(count);
  });
});
