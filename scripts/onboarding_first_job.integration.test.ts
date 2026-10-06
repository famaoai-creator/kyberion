import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { seedFirstJobTestRoot } from './fixtures/first-job-approval-fixture.js';

// No facade, authority, lock, registry, or IO mocks. Only the root and standalone
// operator environment are isolated; no browser identity or credentials are seeded.
const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp', 'first-job-operator-setup-' + process.pid);
const tenant = 'setup-fixture';
const dotId = 'first-job-' + tenant;
const policyPath = 'knowledge/product/governance/front-desk-execution-policy.json';
const profilePath = 'knowledge/personal/tenants/' + tenant + '.json';
const charterPath = 'dots/' + dotId + '.json';
const protectedSourceFiles = [policyPath, 'knowledge/product/governance/security-policy.json'];
const sourceHashes = new Map<string, string>();
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function put(relative: string, value: unknown): void {
  const target = path.join(root, relative);
  safeMkdir(path.dirname(target), { recursive: true });
  safeWriteFile(target, JSON.stringify(value, null, 2) + '\n');
}
function treeSnapshot(directory = root): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const visit = (absolute: string): void => {
    if (!safeExistsSync(absolute)) return;
    const relative = path.relative(directory, absolute).split(path.sep).join('/');
    const stat = safeLstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('Unexpected fixture symlink: ' + relative);
    if (stat.isDirectory()) {
      found.push([relative, 'directory']);
      for (const name of safeReaddir(absolute).sort()) visit(path.join(absolute, name));
    } else found.push([relative, hash(safeReadFile(absolute, { encoding: null }))]);
  };
  visit(directory);
  return found;
}
let api: typeof import('./onboarding_first_job.js');
let authority: typeof import('@agent/core/authority');
let foundation: typeof import('@agent/core/foundation');
let registry: typeof import('@agent/core/organization/tenant-registry');
let tenantFacade: typeof import('@agent/core/organization/tenant-governance');
let charterFacade: typeof import('@agent/core/dot/dot-charter');
let lifecycle: typeof import('@agent/core/dot/dot-lifecycle');
let io: typeof import('@agent/core/secure-io');
const operator = <T>(fn: () => T): T => authority.withExecutionContext('ecosystem_architect', fn);
const ownedTenant = () =>
  authority.withExecutionContext('sovereign_concierge', () =>
    tenantFacade.mutateTenant({
      verb: 'create',
      slug: tenant,
      displayName: 'Synthetic setup fixture',
      apply: true,
      metadata: { onboarding_first_job: 'public-local-diagnostic-v1', synthetic_public_only: true },
      actor: 'integration-fixture',
    })
  );
function readAudit(): Array<Record<string, unknown>> {
  return foundation
    .readTextFile(path.join(root, lifecycle.DOT_LIFECYCLE_AUDIT_PATH))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => foundation.parseSafeJsonObjectInput(line, 'test lifecycle audit'));
}
function expectNoIdentityOrExecution(): void {
  for (const relative of [
    'knowledge/personal/members',
    'active/organizations',
    'active/shared/coordination/channels',
    'active/shared/runtime/work-coordination',
    'active/shared/runtime/approvals',
    'active/shared/runtime/front-desk-execution',
  ])
    expect(safeExistsSync(path.join(root, relative)), relative).toBe(false);
  const files = treeSnapshot()
    .filter(([, kind]) => kind !== 'directory')
    .map(([name]) => name);
  expect(
    files.filter(
      (name) =>
        !name.startsWith('knowledge/product/') &&
        !name.startsWith('scripts/') &&
        /(?:^|\/)(?:approvals?|credentials?|grants?|members|sessions)(?:\/|\.)/.test(name)
    )
  ).toEqual([]);
  expect(safeReaddir(path.join(root, 'knowledge/personal')).sort()).toEqual(['tenants']);
}

beforeAll(async () => {
  for (const file of protectedSourceFiles)
    sourceHashes.set(file, hash(safeReadFile(path.join(sourceRoot, file), { encoding: null })));
  seedFirstJobTestRoot(sourceRoot, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const key of [
    'MISSION_ID',
    'SYSTEM_ROLE',
    'KYBERION_TENANT',
    'KYBERION_ORGANIZATION',
    'KYBERION_PROJECT_ID',
    'KYBERION_SUDO',
    'KYBERION_SESSION_SECRET',
    'KYBERION_OIDC_ISSUER',
    'KYBERION_OIDC_CLIENT_ID',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('MISSION_ROLE', 'worker');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
  vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
  vi.useFakeTimers({ now: new Date('2026-10-06T00:00:00Z'), toFake: ['Date'] });
  vi.resetModules();
  authority = await import('@agent/core/authority');
  foundation = await import('@agent/core/foundation');
  registry = await import('@agent/core/organization/tenant-registry');
  tenantFacade = await import('@agent/core/organization/tenant-governance');
  charterFacade = await import('@agent/core/dot/dot-charter');
  lifecycle = await import('@agent/core/dot/dot-lifecycle');
  io = await import('@agent/core/secure-io');
  api = await import('./onboarding_first_job.js');
}, 60_000);
beforeEach(() => {
  for (const relative of ['knowledge/personal', 'knowledge/confidential', 'dots', 'active'])
    safeRmSync(path.join(root, relative), { recursive: true, force: true });
  put(policyPath, { version: 1, mappings: [] });
});
afterAll(() => {
  process.chdir(sourceRoot);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  safeRmSync(root, { recursive: true, force: true });
  for (const file of protectedSourceFiles)
    expect(
      hash(safeReadFile(path.join(sourceRoot, file), { encoding: null })),
      'real source remained unchanged: ' + file
    ).toBe(sourceHashes.get(file));
});

describe('standalone first-job setup with real governed facades', { timeout: 60_000 }, () => {
  it('plans without any filesystem mutation or identity creation', () => {
    const before = treeSnapshot();
    const identity = authority.resolveIdentityContext();
    const plan = api.planFirstJob(tenant);
    expect(plan.status).toBe('awaiting_explicit_apply');
    expect(plan.draft.scope).toEqual({ tier: 'public', tenant_slug: tenant });
    expect(plan.mapping.viewer).toMatchObject({
      tenantSlugs: [tenant],
      tierAccess: ['public'],
      organizationIds: 'all',
      projectIds: 'all',
      principalId: 'human:presence-studio-localadmin',
    });
    expect(treeSnapshot()).toEqual(before);
    expect(authority.resolveIdentityContext()).toEqual(identity);
  });
  it('refuses a different accepted digest without changing governed files', () => {
    const plan = api.planFirstJob(tenant);
    const before = treeSnapshot();
    expect(() => api.applyFirstJob(tenant, plan.plan_digest.slice(0, -1))).toThrow(
      'first_job_plan_changed'
    );
    // Lock acquisition may leave empty runtime directories, never a lock or data file.
    expect(treeSnapshot().filter(([, kind]) => kind !== 'directory')).toEqual(
      before.filter(([, kind]) => kind !== 'directory')
    );
    expect(safeReaddir(path.join(root, 'active/shared/runtime/locks'))).toEqual([]);
  });
  it('creates the tenant, records draft then activation, maps last, and repeats without writes', () => {
    const plan = api.planFirstJob(tenant);
    const identity = authority.resolveIdentityContext();
    const beforeApply = new Map(treeSnapshot().filter(([, kind]) => kind !== 'directory'));
    const result = api.applyFirstJob(tenant, plan.plan_digest);
    expect(result.status).toBe('already_configured');
    const changedFiles = treeSnapshot()
      .filter(([name, bytes]) => bytes !== 'directory' && beforeApply.get(name) !== bytes)
      .map(([name]) => name);
    expect(changedFiles.sort()).toEqual(
      [
        profilePath,
        charterPath,
        policyPath,
        lifecycle.DOT_LIFECYCLE_AUDIT_PATH,
        'active/shared/runtime/heartbeats/' + plan.draft.runtime.heartbeat_id + '.json',
      ].sort()
    );
    const profile = operator(() => registry.readTenantProfile(tenant));
    expect(profile).toMatchObject({
      tenant_slug: tenant,
      status: 'active',
      metadata: { onboarding_first_job: 'public-local-diagnostic-v1', synthetic_public_only: true },
    });
    expect(charterFacade.findDotCharter(dotId)?.charter).toEqual({
      ...plan.draft,
      status: 'active',
    });
    expect(foundation.readJson(path.join(root, policyPath))).toEqual({
      version: 1,
      mappings: [plan.mapping],
    });
    expect(readAudit().map((row) => [row.event, row.from, row.to])).toEqual([
      ['dot_draft_created', undefined, 'draft'],
      ['dot_status_transition', 'draft', 'active'],
    ]);
    expectNoIdentityOrExecution();
    expect(authority.resolveIdentityContext()).toEqual(identity);
    expect(() => io.safeReadFile(path.join(root, profilePath))).toThrow();
    const beforeRepeat = treeSnapshot();
    const repeatPlan = api.planFirstJob(tenant);
    expect(api.applyFirstJob(tenant, repeatPlan.plan_digest)).toEqual(result);
    expect(treeSnapshot()).toEqual(beforeRepeat);
  });
  it('resumes an owned draft through activation without recreating it', () => {
    ownedTenant();
    const draft = api.diagnosticDraft(tenant);
    lifecycle.createDraftDotCharter(draft, { actor: 'integration-fixture' });
    const plan = api.planFirstJob(tenant);
    const result = api.applyFirstJob(tenant, plan.plan_digest);
    expect(result.status).toBe('already_configured');
    expect(readAudit().filter((row) => row.event === 'dot_draft_created')).toHaveLength(1);
    expect(readAudit().filter((row) => row.event === 'dot_status_transition')).toHaveLength(1);
    expectNoIdentityOrExecution();
  });
  it('preserves an unrelated real tenant profile', () => {
    authority.withExecutionContext('sovereign_concierge', () =>
      tenantFacade.mutateTenant({
        verb: 'create',
        slug: tenant,
        displayName: 'Unrelated fixture',
        apply: true,
        actor: 'integration-fixture',
      })
    );
    const before = treeSnapshot();
    expect(() => api.planFirstJob(tenant)).toThrow('first_job_existing_tenant_not_owned');
    expect(treeSnapshot()).toEqual(before);
    expect(() => api.applyFirstJob(tenant, 'a'.repeat(64))).toThrow(
      'first_job_existing_tenant_not_owned'
    );
    expect(treeSnapshot().filter(([, kind]) => kind !== 'directory')).toEqual(
      before.filter(([, kind]) => kind !== 'directory')
    );
    expect(safeReaddir(path.join(root, 'active/shared/runtime/locks'))).toEqual([]);
  });
  it('preserves a conflicting draft and does not replace its purpose', () => {
    ownedTenant();
    lifecycle.createDraftDotCharter(
      { ...api.diagnosticDraft(tenant), purpose: 'Different purpose' },
      { actor: 'integration-fixture' }
    );
    const before = treeSnapshot();
    expect(() => api.planFirstJob(tenant)).toThrow('first_job_charter_conflict');
    expect(treeSnapshot()).toEqual(before);
  });
  it('does not overwrite another mapping for the local principal', () => {
    const conflict = api.planFirstJob('other-fixture').mapping;
    operator(() =>
      io.safeWriteFile(
        path.join(root, policyPath),
        JSON.stringify({ version: 1, mappings: [conflict] })
      )
    );
    const before = treeSnapshot();
    expect(() => api.planFirstJob(tenant)).toThrow('first_job_mapping_conflict');
    expect(treeSnapshot()).toEqual(before);
  });
  it('preserves a governed pause and rejects an old reviewed plan', () => {
    const initial = api.planFirstJob(tenant);
    api.applyFirstJob(tenant, initial.plan_digest);
    const ready = api.planFirstJob(tenant);
    lifecycle.transitionDotCharterStatus(dotId, 'paused', { actor: 'integration-fixture' });
    const before = treeSnapshot();
    expect(() => api.planFirstJob(tenant)).toThrow('first_job_charter_not_active');
    expect(() => api.applyFirstJob(tenant, ready.plan_digest)).toThrow(
      'first_job_charter_not_active'
    );
    expect(treeSnapshot()).toEqual(before);
    expect(charterFacade.findDotCharter(dotId)?.charter.status).toBe('paused');
    expect(safeExistsSync(path.join(root, charterPath))).toBe(true);
  });
});
