/**
 * NI-05 hermetic tests: scope-closure retirement, orphan detection, ledger
 * report — plus the AL-03 mission-closure hook that fires the retirement.
 *
 * KM-04 convention (same as mission-artifact-closure.test.ts): a temp
 * KYBERION_ROOT is set BEFORE any repo module is imported (path-resolver
 * binds its project root at import time), so nothing here touches the real
 * active/ tree — identity journal, mission trees and project trees all live
 * inside the temp root.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Closure shells out to `git bundle create` — emulate it so no child
// process is spawned (identical seam to the AL-03 closure test).
vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: (command: string, args: string[] = []) => {
      if (command === 'git' && args[0] === 'bundle' && args[1] === 'create') {
        fs.writeFileSync(args[2]!, 'bundle-content');
        return '';
      }
      throw new Error(`unexpected safeExec in NI-05 test: ${command} ${args.join(' ')}`);
    },
  };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRITER_LEASE_SCHEMAS = ['writer-lease.schema.json', 'writer-lease-metrics.schema.json'].map(
  (name) => ({
    name,
    content: fs.readFileSync(path.join(REPO_ROOT, 'knowledge/product/schemas', name), 'utf8'),
  })
);

let tmpRoot: string;
let governance: typeof import('./nhi-lifecycle-governance.js');
let identity: typeof import('./agent-identity.js');
let authority: typeof import('./authority.js');
let closure: typeof import('./mission-artifact-closure.js');
let verification: typeof import('./nhi-actor-verification.js');

let journalCounter = 0;

function nextJournalPath(): string {
  journalCounter += 1;
  return `active/shared/tmp/ni05-tests/agent-identities-${journalCounter}.jsonl`;
}

function issue(slug: string, affiliation: Record<string, string>, organizationId = 'demo-org') {
  return authority.withExecutionContext('mission_controller', () =>
    identity.issueAgentIdentity({
      kind: 'agent',
      organizationId,
      slug,
      accountableHumanId: 'human:founder',
      affiliation,
    } as Parameters<typeof identity.issueAgentIdentity>[0])
  );
}

function seedMission(id: string): string {
  const dir = path.join(tmpRoot, 'active', 'missions', 'public', id);
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'evidence', 'closeout.md'), '# Closeout');
  return dir;
}

function seedProject(id: string): string {
  const dir = path.join(tmpRoot, 'active', 'projects', 'public', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  tmpRoot = path.join(os.tmpdir(), `kyb-ni05-${randomUUID()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}');
  process.env.KYBERION_ROOT = tmpRoot;
  process.env.MISSION_ROLE = 'mission_controller';

  // safeWriteFile runs the policy-engine gate — seed the real policy file so
  // writes inside the temp root are allowed.
  const policyTarget = path.join(tmpRoot, 'knowledge', 'product', 'governance');
  fs.mkdirSync(policyTarget, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'knowledge/product/governance/agent-policies.yaml'),
    path.join(policyTarget, 'agent-policies.yaml')
  );
  // findMissionPath resolves tiered mission roots through this config — without
  // it, a seeded mission tree in the temp root would read as "scope missing"
  // and every affiliated identity would look orphaned.
  fs.copyFileSync(
    path.join(REPO_ROOT, 'knowledge/product/governance/mission-management-config.json'),
    path.join(policyTarget, 'mission-management-config.json')
  );
  const schemaTarget = path.join(tmpRoot, 'knowledge', 'product', 'schemas');
  fs.mkdirSync(schemaTarget, { recursive: true });
  for (const schema of WRITER_LEASE_SCHEMAS) {
    fs.writeFileSync(path.join(schemaTarget, schema.name), schema.content);
  }

  governance = await import('./nhi-lifecycle-governance.js');
  identity = await import('./agent-identity.js');
  authority = await import('./authority.js');
  closure = await import('./mission-artifact-closure.js');
  verification = await import('./nhi-actor-verification.js');
});

afterAll(() => {
  delete process.env.KYBERION_ROOT;
  delete process.env.MISSION_ROLE;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  identity.resetAgentIdentityServiceForTests(nextJournalPath());
});

afterEach(() => {
  governance.setNhiGovernanceAuditSinkForTests(null);
  identity.resetAgentIdentityServiceForTests();
});

describe('NI-05 scope-closure retirement', () => {
  it('retires the closing mission’s identities and leaves every other scope alone', () => {
    const mine = issue('worker-mine', { organization_id: 'demo-org', mission_id: 'MSN-NI05-A' });
    const other = issue('worker-other', { organization_id: 'demo-org', mission_id: 'MSN-NI05-B' });
    const unaffiliated = issue('worker-free', { organization_id: 'demo-org' });

    const result = governance.retireIdentitiesForScope({
      scope: 'mission',
      scopeId: 'MSN-NI05-A',
      reason: 'mission finished',
    });

    expect(result.status).toBe('retired');
    expect(result.retired).toEqual([mine.nhi_id]);
    expect(result.skipped).toEqual([]);
    expect(identity.getAgentIdentity(mine.nhi_id)?.lifecycle_status).toBe('retired');
    expect(identity.getAgentIdentity(mine.nhi_id)?.retire_reason).toBe('mission finished');
    expect(identity.getAgentIdentity(other.nhi_id)?.lifecycle_status).toBe('provisioned');
    expect(identity.getAgentIdentity(unaffiliated.nhi_id)?.lifecycle_status).toBe('provisioned');
  });

  it('is idempotent: a second closure of the same scope is a no-op', () => {
    issue('worker-idem', { organization_id: 'demo-org', mission_id: 'MSN-NI05-IDEM' });
    const first = governance.retireIdentitiesForScope({
      scope: 'mission',
      scopeId: 'MSN-NI05-IDEM',
      reason: 'first',
    });
    const second = governance.retireIdentitiesForScope({
      scope: 'mission',
      scopeId: 'MSN-NI05-IDEM',
      reason: 'second',
    });

    expect(first.retired).toHaveLength(1);
    expect(second).toMatchObject({ status: 'noop', retired: [] });
  });

  it('a tenant closure matches only explicit tenant_slug affiliation', () => {
    const byTenant = issue('worker-tenant', {
      organization_id: 'demo-org',
      tenant_slug: 'tenant-alpha',
    });
    const sameOrg = issue('worker-org', { organization_id: 'demo-org' });
    const sameProjectName = issue('worker-proj', {
      organization_id: 'demo-org',
      project_id: 'tenant-alpha',
    });
    const unrelated = issue('worker-elsewhere', {
      organization_id: 'demo-org',
      project_id: 'tenant-beta',
    });

    const result = governance.retireIdentitiesForScope({
      scope: 'tenant',
      scopeId: 'tenant-alpha',
      reason: 'tenant offboarded',
    });

    expect(result.retired).toEqual([byTenant.nhi_id]);
    expect(identity.getAgentIdentity(sameOrg.nhi_id)?.lifecycle_status).toBe('provisioned');
    expect(identity.getAgentIdentity(sameProjectName.nhi_id)?.lifecycle_status).toBe('provisioned');
    expect(identity.getAgentIdentity(unrelated.nhi_id)?.lifecycle_status).toBe('provisioned');
  });

  it('reports (never throws) when the caller’s role may not retire identities', () => {
    const record = issue('worker-ungoverned', {
      organization_id: 'demo-org',
      mission_id: 'MSN-NI05-ROLE',
    });
    const previousRole = process.env.MISSION_ROLE;
    delete process.env.MISSION_ROLE;
    try {
      const result = governance.retireIdentitiesForScope({
        scope: 'mission',
        scopeId: 'MSN-NI05-ROLE',
        reason: 'no authority',
      });
      expect(result.status).toBe('noop');
      expect(result.retired).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.nhi_id).toBe(record.nhi_id);
      // Never escalates: the identity is still live.
      expect(identity.getAgentIdentity(record.nhi_id)?.lifecycle_status).toBe('provisioned');
    } finally {
      if (previousRole !== undefined) process.env.MISSION_ROLE = previousRole;
    }
  });

  it('audits each retirement through the injected sink', () => {
    const events: any[] = [];
    governance.setNhiGovernanceAuditSinkForTests((event) => events.push(event));
    const record = issue('worker-audited', {
      organization_id: 'demo-org',
      mission_id: 'MSN-NI05-AUDIT',
    });

    governance.retireIdentitiesForScope({
      scope: 'mission',
      scopeId: 'MSN-NI05-AUDIT',
      reason: 'closure ceremony',
    });

    expect(events).toEqual([
      expect.objectContaining({
        action: governance.NHI_IDENTITY_RETIRED_EVENT,
        nhi_id: record.nhi_id,
        reason: 'closure ceremony',
      }),
    ]);
  });
});

describe('NI-05 mission closure hook (AL-03 ceremony)', () => {
  it('mission finish closure auto-retires the mission’s identities, and the retired actor is then refused under enforce', () => {
    const id = 'MSN-NI05-HOOK';
    const dir = seedMission(id);
    const record = issue('worker-hooked', { organization_id: 'demo-org', mission_id: id });

    const result = closure.closeMissionArtifacts({ missionId: id, missionDir: dir });
    expect(result.status).toBe('closed');
    expect(identity.getAgentIdentity(record.nhi_id)?.lifecycle_status).toBe('retired');

    // NI-02 enforce: a retired identity can no longer act.
    const previousMode = process.env.KYBERION_NHI_ACTOR;
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    verification.clearNhiActorVerificationCache();
    verification.setNhiActorAuditSinkForTests(() => {});
    try {
      expect(verification.verifyNhiActor(record.nhi_id).verdict).toBe('retired');
      expect(() =>
        verification.enforceNhiActorPolicy(record.nhi_id, 'work-item claim')
      ).toThrowError();
    } finally {
      verification.setNhiActorAuditSinkForTests(null);
      verification.clearNhiActorVerificationCache();
      if (previousMode === undefined) delete process.env.KYBERION_NHI_ACTOR;
      else process.env.KYBERION_NHI_ACTOR = previousMode;
    }
  });
});

describe('NI-05 tenant closure', () => {
  it('retires only identities explicitly affiliated with the tenant', () => {
    const tenantIdentity = issue('worker-tenant-bound', {
      organization_id: 'demo-org',
      tenant_slug: 'acme-corp',
    });
    const organizationIdentity = issue('worker-org-bound', {
      organization_id: 'demo-org',
    });

    const result = governance.retireIdentitiesForScope({
      scope: 'tenant',
      scopeId: 'acme-corp',
      reason: 'tenant offboarding',
    });

    expect(result.retired).toEqual([tenantIdentity.nhi_id]);
    expect(identity.getAgentIdentity(tenantIdentity.nhi_id)?.lifecycle_status).toBe('retired');
    expect(identity.getAgentIdentity(organizationIdentity.nhi_id)?.lifecycle_status).toBe(
      'provisioned'
    );
  });
});

describe('NI-05 orphan detection', () => {
  it('flags a live identity whose mission scope no longer exists', () => {
    const live = seedMission('MSN-NI05-LIVE');
    expect(fs.existsSync(live)).toBe(true);
    const kept = issue('worker-live-scope', {
      organization_id: 'demo-org',
      mission_id: 'MSN-NI05-LIVE',
    });
    const orphaned = issue('worker-gone-scope', {
      organization_id: 'demo-org',
      mission_id: 'MSN-NI05-VANISHED',
    });

    const orphans = governance.listOrphanNhiIdentities();
    expect(orphans).toEqual([
      expect.objectContaining({
        nhi_id: orphaned.nhi_id,
        reason: 'mission_scope_missing',
        missing_scope_id: 'MSN-NI05-VANISHED',
        accountable_human_id: 'human:founder',
      }),
    ]);
    expect(orphans.map((o) => o.nhi_id)).not.toContain(kept.nhi_id);
    expect(governance.isNhiLedgerHealthy()).toBe(false);
  });

  it('flags a live identity whose project scope no longer exists', () => {
    seedProject('proj-present');
    issue('worker-project-ok', { organization_id: 'demo-org', project_id: 'proj-present' });
    const orphaned = issue('worker-project-gone', {
      organization_id: 'demo-org',
      project_id: 'proj-removed',
    });

    expect(governance.listOrphanNhiIdentities()).toEqual([
      expect.objectContaining({
        nhi_id: orphaned.nhi_id,
        reason: 'project_scope_missing',
        missing_scope_id: 'proj-removed',
      }),
    ]);
  });

  it('a retired identity is never an orphan — retirement is the cure', () => {
    const record = issue('worker-retired-scope', {
      organization_id: 'demo-org',
      mission_id: 'MSN-NI05-CLOSED',
    });
    expect(governance.listOrphanNhiIdentities()).toHaveLength(1);

    governance.retireIdentitiesForScope({
      scope: 'mission',
      scopeId: 'MSN-NI05-CLOSED',
      reason: 'archived',
    });

    expect(governance.listOrphanNhiIdentities()).toEqual([]);
    expect(governance.isNhiLedgerHealthy()).toBe(true);
    expect(identity.getAgentIdentity(record.nhi_id)?.lifecycle_status).toBe('retired');
  });

  it('an identity with no scope affiliation is never an orphan', () => {
    issue('worker-org-only', { organization_id: 'demo-org' });
    expect(governance.listOrphanNhiIdentities()).toEqual([]);
    expect(governance.isNhiLedgerHealthy()).toBe(true);
  });

  it('audits each detected orphan through the injected sink', () => {
    const events: any[] = [];
    governance.setNhiGovernanceAuditSinkForTests((event) => events.push(event));
    const orphaned = issue('worker-orphan-audit', {
      organization_id: 'demo-org',
      mission_id: 'MSN-NI05-NOWHERE',
    });

    expect(governance.isNhiLedgerHealthy()).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        action: governance.NHI_ORPHAN_DETECTED_EVENT,
        nhi_id: orphaned.nhi_id,
      }),
    ]);
  });
});

describe('NI-05 ledger report', () => {
  it('inventories every identity with owner, state, affiliation and last activity', () => {
    const active = issue('worker-report-active', {
      organization_id: 'demo-org',
      mission_id: 'MSN-NI05-REPORT',
    });
    seedMission('MSN-NI05-REPORT');
    const retired = issue('worker-report-retired', { organization_id: 'demo-org' });
    authority.withExecutionContext('mission_controller', () => {
      identity.bindRuntimeInstance({ nhiId: active.nhi_id, instanceId: 'inst-1', pid: 1234 });
      identity.retireAgentIdentity(retired.nhi_id, 'done');
    });

    const report = governance.buildNhiLedgerReport({ nowIso: '2026-07-26T00:00:00.000Z' });

    expect(report.generated_at).toBe('2026-07-26T00:00:00.000Z');
    expect(report.total).toBe(2);
    expect(report.by_status).toMatchObject({ active: 1, retired: 1, provisioned: 0, suspended: 0 });
    expect(report.orphans).toEqual([]);

    const activeEntry = report.identities.find((entry) => entry.nhi_id === active.nhi_id);
    expect(activeEntry).toMatchObject({
      accountable_human_id: 'human:founder',
      lifecycle_status: 'active',
      runtime_instances: 1,
      affiliation: { organization_id: 'demo-org', mission_id: 'MSN-NI05-REPORT' },
    });
    // Last activity tracks the newest event (the instance bind), not creation.
    const bound = identity.getAgentIdentity(active.nhi_id)!;
    expect(activeEntry!.last_activity_at).toBe(bound.runtime_instances?.[0]?.bound_at);
    expect(activeEntry!.last_activity_at >= bound.created_at).toBe(true);
  });

  it('carries the orphans into the report so an operator sees them by name', () => {
    const orphaned = issue('worker-report-orphan', {
      organization_id: 'demo-org',
      mission_id: 'MSN-NI05-ABSENT',
    });
    const report = governance.buildNhiLedgerReport();
    expect(report.orphans.map((orphan) => orphan.nhi_id)).toEqual([orphaned.nhi_id]);
  });

  it('an empty ledger reports zeros rather than failing', () => {
    const report = governance.buildNhiLedgerReport();
    expect(report).toMatchObject({ total: 0, identities: [], orphans: [] });
    expect(report.by_status).toEqual({ provisioned: 0, active: 0, suspended: 0, retired: 0 });
  });
});
