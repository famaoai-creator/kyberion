/**
 * Hermetic tests for owner-derived scope resolution.
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let tmpRoot: string;
let scope: typeof import('./owner-scope.js');
let projects: typeof import('./project/project-registry.js');
let executionScope: typeof import('./foundation/execution-scope.js');

function seed(relative: string, from = relative): void {
  const target = path.join(tmpRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, from), target, { recursive: true });
}

function writeMission(relativeDir: string, state: Record<string, unknown>): void {
  const dir = path.join(tmpRoot, relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mission-state.json'),
    JSON.stringify({
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'worker',
      confidence_score: 1,
      status: 'active',
      git: { branch: 'm', start_commit: 'a', latest_commit: 'a', checkpoints: [] },
      history: [],
      ...state,
    })
  );
}

function writeOrganization(tier: string, tenant: string, org: string): void {
  fs.mkdirSync(path.join(tmpRoot, 'active/organizations', tier, tenant, org, 'state'), {
    recursive: true,
  });
}

describe('resolveOwnerScope', () => {
  const savedTenant = process.env.KYBERION_TENANT;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyb-owner-scope-'));
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
    seed('knowledge/product/governance/agent-policies.yaml');
    seed('knowledge/product/governance/mission-management-config.json');
    seed('knowledge/product/schemas');
    process.env.KYBERION_ROOT = tmpRoot;
    process.env.MISSION_ROLE = 'mission_controller';
    delete process.env.KYBERION_TENANT;
    scope = await import('./owner-scope.js');
    projects = await import('./project/project-registry.js');
    executionScope = await import('./foundation/execution-scope.js');

    writeMission('active/missions/public/MSN-OWN-PUB', {
      mission_id: 'MSN-OWN-PUB',
      tier: 'public',
      relationships: { project: { project_id: 'PRJ-OWN-PUB' } },
    });
    writeMission('active/missions/confidential/acme/MSN-OWN-ACME', {
      mission_id: 'MSN-OWN-ACME',
      tier: 'confidential',
      tenant_slug: 'acme',
      organization_id: 'org-acme',
    });
    // Same id in two tenants: ids are unique only within a scope.
    writeMission('active/missions/confidential/acme/MSN-OWN-TWIN', {
      mission_id: 'MSN-OWN-TWIN',
      tier: 'confidential',
      tenant_slug: 'acme',
    });
    writeMission('active/missions/confidential/globex/MSN-OWN-TWIN', {
      mission_id: 'MSN-OWN-TWIN',
      tier: 'confidential',
      tenant_slug: 'globex',
    });
    projects.saveProjectRecord({
      project_id: 'PRJ-OWN-ACME',
      name: 'acme project',
      summary: 'owner scope test',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'acme',
      organization_id: 'org-acme',
    } as Parameters<typeof projects.saveProjectRecord>[0]);
    // Unreadable (schema-invalid) state in a flat directory: tenant unknown.
    fs.mkdirSync(path.join(tmpRoot, 'active/missions/confidential/MSN-OWN-BROKEN'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'active/missions/confidential/MSN-OWN-BROKEN/mission-state.json'),
      JSON.stringify({ mission_id: 'MSN-OWN-BROKEN', tenant_slug: 'acme' })
    );
    // A state naming another tenant than the directory it sits in.
    writeMission('active/missions/confidential/acme/MSN-OWN-MISPLACED', {
      mission_id: 'MSN-OWN-MISPLACED',
      tier: 'confidential',
      tenant_slug: 'globex',
    });
    // A recorded tenant that is not a slug: unknown, never shared.
    writeMission('active/missions/public/MSN-OWN-BADTENANT', {
      mission_id: 'MSN-OWN-BADTENANT',
      tier: 'public',
      tenant_id: '9f1c2d3e-uuid_like',
    });
    // Legacy `default` tenant sentinel = untenanted.
    writeMission('active/missions/public/MSN-OWN-DEFAULT', {
      mission_id: 'MSN-OWN-DEFAULT',
      tier: 'public',
      tenant_id: 'default',
    });
    writeOrganization('public', 'shared', 'org-solo');
    writeOrganization('confidential', 'acme', 'org-dup');
    writeOrganization('confidential', 'globex', 'org-dup');
  });

  afterEach(() => {
    delete process.env.KYBERION_TENANT;
  });

  afterAll(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
    delete process.env.KYBERION_ROOT;
    delete process.env.MISSION_ROLE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('derives a mission scope from its state, independent of KYBERION_TENANT', () => {
    expect(scope.resolveOwnerScope({ kind: 'mission', id: 'msn-own-pub' })).toMatchObject({
      tier: 'public',
      tenant: 'shared',
      project_id: 'PRJ-OWN-PUB',
      dir: path.join(tmpRoot, 'active/missions/public/MSN-OWN-PUB'),
    });
    // Found without the env binding (findMissionPath would miss it).
    expect(scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-ACME' })).toMatchObject({
      tier: 'confidential',
      tenant: 'acme',
      organization_id: 'org-acme',
    });
    expect(scope.resolveMissionDir('MSN-OWN-ACME')).toBe(
      path.join(tmpRoot, 'active/missions/confidential/acme/MSN-OWN-ACME')
    );
  });

  it("never resolves another tenant's owner for a tenant-bound identity", () => {
    process.env.KYBERION_TENANT = 'globex';
    expect(() => scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-ACME' })).toThrow(
      /\[OWNER_NOT_FOUND\]/u
    );
    expect(scope.tryResolveOwnerScope({ kind: 'project', id: 'PRJ-OWN-ACME' })).toBeNull();
    // Its own twin is the only visible one, so it is no longer ambiguous.
    expect(scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-TWIN' }).tenant).toBe('globex');
    // Untenanted owners stay visible.
    expect(scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-PUB' }).tier).toBe('public');
  });

  it('treats a caller tier/tenant as a narrowing hint, never an override', () => {
    expect(
      scope.resolveOwnerScope(
        { kind: 'mission', id: 'MSN-OWN-ACME' },
        { tier: 'confidential', tenant: 'acme' }
      ).tenant
    ).toBe('acme');
    let error: unknown;
    try {
      scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-ACME' }, { tier: 'public' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(scope.OwnerScopeError);
    expect(error).toMatchObject({
      code: 'SCOPE_CONTRADICTS_OWNER',
      expected: { tier: 'confidential', tenant: 'acme' },
      actual: { tier: 'public' },
    });
    expect((error as Error).message).toMatch(
      /^\[SCOPE_CONTRADICTS_OWNER\] .+ — .+ \| next: .*tier 'confidential' and tenant 'acme'/u
    );
  });

  it('fails closed on an ambiguous id and lets a hint select one', () => {
    expect(() => scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-TWIN' })).toThrow(
      /\[OWNER_AMBIGUOUS\] mission MSN-OWN-TWIN exists in 2 scopes/u
    );
    expect(
      scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-TWIN' }, { tenant: 'globex' }).dir
    ).toBe(path.join(tmpRoot, 'active/missions/confidential/globex/MSN-OWN-TWIN'));
  });

  it('derives a project scope from the project record', () => {
    expect(scope.resolveOwnerScope({ kind: 'project', id: 'PRJ-OWN-ACME' })).toMatchObject({
      tier: 'confidential',
      tenant: 'acme',
      organization_id: 'org-acme',
      dir: path.join(tmpRoot, 'active/projects/confidential/acme/PRJ-OWN-ACME'),
    });
    expect(() =>
      scope.resolveOwnerScope({ kind: 'project', id: 'PRJ-OWN-ACME' }, { tenant: 'shared' })
    ).toThrow(/\[SCOPE_CONTRADICTS_OWNER\]/u);
    expect(() => scope.resolveOwnerScope({ kind: 'project', id: 'PRJ-MISSING' })).toThrow(
      /\[OWNER_NOT_FOUND\] project PRJ-MISSING not found .*pnpm project create/u
    );
  });

  it('finds an organization by a unique id and requires a selector when it is not unique', () => {
    expect(scope.resolveOwnerScope({ kind: 'organization', id: 'org-solo' })).toMatchObject({
      tier: 'public',
      tenant: 'shared',
      dir: path.join(tmpRoot, 'active/organizations/public/shared/org-solo'),
    });
    expect(() => scope.resolveOwnerScope({ kind: 'organization', id: 'org-dup' })).toThrow(
      /\[OWNER_AMBIGUOUS\] organization org-dup exists in 2 scopes \(confidential\/acme, confidential\/globex\)/u
    );
    expect(
      scope.resolveOwnerScope(
        { kind: 'organization', id: 'org-dup' },
        { tier: 'confidential', tenant: 'acme' }
      ).tenant
    ).toBe('acme');
    process.env.KYBERION_TENANT = 'acme';
    expect(scope.resolveOwnerScope({ kind: 'organization', id: 'org-dup' }).tenant).toBe('acme');
  });

  it('fails closed when a mission tenant cannot be established or is inconsistent', () => {
    // Unreadable state: an unbound identity sees it untenanted, a bound one never.
    expect(scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-BROKEN' }).tenant).toBe(
      'shared'
    );
    process.env.KYBERION_TENANT = 'globex';
    expect(scope.tryResolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-BROKEN' })).toBeNull();
    expect(scope.tryResolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-BADTENANT' })).toBeNull();
    delete process.env.KYBERION_TENANT;
    // State tenant disagreeing with its tenant directory resolves nowhere.
    expect(scope.tryResolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-MISPLACED' })).toBeNull();
    // `default` is untenanted, never a tenant.
    expect(scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-DEFAULT' }).tenant).toBe(
      'shared'
    );
    expect(
      scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-DEFAULT' }, { tenant: 'default' })
        .tier
    ).toBe('public');
  });

  it('honours a tenant bound through the execution scope, like identity resolution', () => {
    executionScope.runInExecutionScope({ tenantBound: true, tenantSlug: 'globex' }, () => {
      expect(scope.tryResolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-ACME' })).toBeNull();
      expect(scope.resolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-TWIN' }).tenant).toBe(
        'globex'
      );
    });
  });

  it('reads treat an ambiguous id as unknown; writes still fail closed', () => {
    expect(scope.tryResolveOwnerScope({ kind: 'mission', id: 'MSN-OWN-TWIN' })).toBeNull();
    expect(() => scope.resolveMissionDir('MSN-OWN-TWIN')).toThrow(/\[OWNER_AMBIGUOUS\]/u);
  });

  it('backs findMissionPath and loadState with the resolver (S7)', async () => {
    const { findMissionPath } = await import('./path-resolver.js');
    const { loadState } = await import('./mission/mission-state.js');
    // A tenant-partitioned mission is found without the process tenant set.
    expect(findMissionPath('MSN-OWN-ACME')).toBe(
      path.join(tmpRoot, 'active/missions/confidential/acme/MSN-OWN-ACME')
    );
    expect(loadState('MSN-OWN-ACME')?.tenant_slug).toBe('acme');
    // Ambiguous ids fail closed instead of picking one.
    expect(() => findMissionPath('MSN-OWN-TWIN')).toThrow(/\[OWNER_AMBIGUOUS\]/);
    // A bound identity never reaches another tenant's mission, even through
    // the legacy directory scan (a flat dir holding another tenant's state).
    process.env.KYBERION_TENANT = 'globex';
    expect(findMissionPath('MSN-OWN-ACME')).toBeNull();
    expect(findMissionPath('MSN-OWN-BROKEN')).toBeNull();
    expect(loadState('MSN-OWN-ACME')).toBeNull();
    delete process.env.KYBERION_TENANT;
    // A pre-materialized mission (directory, no state yet) is still found.
    fs.mkdirSync(path.join(tmpRoot, 'active/missions/public/MSN-OWN-PREMAT'), { recursive: true });
    expect(findMissionPath('MSN-OWN-PREMAT')).toBe(
      path.join(tmpRoot, 'active/missions/public/MSN-OWN-PREMAT')
    );
    expect(loadState('MSN-OWN-PREMAT')).toBeNull();
  });

  it('answers a lookup nested inside the locator with the plain scan, not recursion', async () => {
    const resolver = await import('./path-resolver.js');
    const nested: Array<string | null> = [];
    resolver.registerMissionLocator((missionId) => {
      // e.g. secure-io's permission check resolving identity mid-lookup
      nested.push(resolver.findMissionPath(missionId));
      return undefined;
    });
    try {
      // Outer call: the locator found nothing, so a directory holding a state
      // is not accepted from the scan; the nested call took the plain scan.
      expect(resolver.findMissionPath('MSN-OWN-PUB')).toBeNull();
      expect(nested).toEqual([path.join(tmpRoot, 'active/missions/public/MSN-OWN-PUB')]);
    } finally {
      vi.resetModules();
      await import('./owner-scope.js');
    }
  });

  it('rejects ids that are not a single safe segment', () => {
    for (const id of ['../x', 'a/b', '..', '']) {
      expect(() => scope.resolveOwnerScope({ kind: 'mission', id })).toThrow(
        /\[OWNER_ID_INVALID\]/u
      );
    }
  });
});
