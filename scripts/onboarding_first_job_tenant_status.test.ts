import {
  seedFirstJobTestRoot,
  syntheticFirstJobOwner,
  FIRST_JOB_TEST_SESSION_KEY,
  FIRST_JOB_TEST_ISSUER,
  FIRST_JOB_TEST_SUBJECT,
} from './fixtures/first-job-approval-fixture.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeReadFile, safeWriteFile, safeRmSync } from '@agent/core/secure-io';
import type { DotDispatchDeps } from '@agent/core/dot/dot-dispatch';
import type { DotCharter } from '@agent/core/dot/dot-charter';
import type { FrontDeskExecutionMapping } from '@agent/core/surface/front-desk-execution-contract';

// Real secure-io, authority and governed stores. Only the fixture filesystem
// root is substituted; no permission, registry, binding or charter mock.
const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp', 'first-job-tenant-status-' + process.pid);
const tenant = 'diagnostic-fixture';
const charter: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'first-job-diagnostic-fixture',
  version: '1.0.0',
  title: 'Diagnostic fixture',
  purpose: 'Produce a local synthetic receipt.',
  status: 'active',
  scope: { tier: 'public', tenant_slug: tenant },
  goal: { statement: 'Produce a receipt.' },
  attention: { triggers: [] },
  authority: {
    authority_role: 'infrastructure_sentinel',
    allowed_work_shapes: ['pipeline'],
    allowed_pipelines: ['pipelines/front-desk-request-receipt.json'],
    max_concurrent_delegations: 1,
  },
  decisions: { default_decision: 'approve', escalate_channel: 'surface' },
  notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
  runtime: { heartbeat_id: 'dot-first-job-fixture', execution_mode: 'front_desk_diagnostic' },
};
const mapping: FrontDeskExecutionMapping = {
  id: charter.dot_id,
  dotId: charter.dot_id,
  viewer: {
    principalId: 'human:presence-studio-localadmin',
    source: 'loopback',
    role: 'localadmin',
    tenantSlugs: [tenant],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public'],
  },
  exactCommand: 'Create a local diagnostic request receipt artifact.',
  pipeline: { path: 'pipelines/front-desk-request-receipt.json', version: 'receipt-v1' },
};
const profile = {
  tenant_slug: tenant,
  display_name: 'PRIVATE_PROFILE_CANARY',
  status: 'active',
  assigned_role: 'owner',
  metadata: { private_value: 'PRIVATE_METADATA_CANARY' },
};
const profilePath = 'knowledge/personal/tenants/' + tenant + '.json';
const charterPath = 'dots/' + charter.dot_id + '.json';
const policyPath = 'knowledge/product/governance/front-desk-execution-policy.json';
function put(file: string, value: unknown): void {
  const target = path.join(root, file);
  safeMkdir(path.dirname(target), { recursive: true });
  safeWriteFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}
let browser: typeof import('@agent/core/authn-providers');
let approvalsFacade: typeof import('@agent/core/surface/first-job-approval');
let browserToken = '';
let authority: typeof import('@agent/core/authority');
let foundation: typeof import('@agent/core/foundation');
let io: typeof import('@agent/core/secure-io');
let store: typeof import('@agent/core/surface/front-desk-conversation-store');
let dispatch: typeof import('@agent/core/dot/dot-dispatch');
let execution: typeof import('@agent/core/surface/front-desk-execution');
let helper: typeof import('./onboarding_first_job_tenant_status.js');
let callback: ReturnType<typeof helper.createFirstJobTenantStatusAssertion>;
let proposal: ReturnType<typeof execution.frontDeskExecutionProposal>;
const bound = <T>(fn: () => T, slug: string | undefined = tenant, org?: string): T =>
  authority.withExecutionContext('infrastructure_sentinel', fn, 'worker', slug, org);
const assertStatus = () => callback(tenant, { charter, proposal });

beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, root);
  put('package.json', {});
  for (const file of [
    'knowledge/product/governance/security-policy.json',
    'knowledge/product/governance/intent-phrase-lexicon.json',
    'knowledge/product/schemas/intent-phrase-lexicon.schema.json',
    'knowledge/product/orchestration/user-facing-vocabulary.json',
    'knowledge/product/schemas/user-facing-vocabulary.schema.json',
    'knowledge/product/governance/work-scope-policy.json',
    'knowledge/product/schemas/work-scope-policy.schema.json',
    'knowledge/product/schemas/governed-work-item.schema.json',
    'knowledge/product/schemas/workitem-label-taxonomy.schema.json',
    'knowledge/product/governance/authority-role-index.json',
    'knowledge/product/governance/role-assumption-policy.json',
    'knowledge/product/schemas/dot-charter.schema.json',
    'knowledge/product/schemas/tenant-profile.schema.json',
    'knowledge/product/schemas/front-desk-execution-policy.schema.json',
    'knowledge/product/schemas/authority-role-index.schema.json',
    'pipelines/front-desk-request-receipt.json',
  ])
    put(file, String(safeReadFile(path.join(sourceRoot, file), { encoding: 'utf8' })));
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('MISSION_ID', '');
  vi.stubEnv('MISSION_ROLE', 'worker');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('KYBERION_SUDO', '');
  vi.stubEnv('KYBERION_TENANT', '');
  vi.stubEnv('KYBERION_SESSION_SECRET', FIRST_JOB_TEST_SESSION_KEY);
  vi.stubEnv('KYBERION_OIDC_ISSUER', FIRST_JOB_TEST_ISSUER);
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'fixture');
  vi.resetModules();
  authority = await import('@agent/core/authority');
  foundation = await import('@agent/core/foundation');
  io = await import('@agent/core/secure-io');
  store = await import('@agent/core/surface/front-desk-conversation-store');
  dispatch = await import('@agent/core/dot/dot-dispatch');
  execution = await import('@agent/core/surface/front-desk-execution');
  helper = await import('./onboarding_first_job_tenant_status.js');
  browser = await import('@agent/core/authn-providers');
  approvalsFacade = await import('@agent/core/surface/first-job-approval');
}, 60_000);
beforeEach(() => {
  put('knowledge/personal/members/owner.json', syntheticFirstJobOwner(tenant));
  browserToken = browser.mintBrowserSessionToken({
    idpIssuer: FIRST_JOB_TEST_ISSUER,
    subject: FIRST_JOB_TEST_SUBJECT,
    ttlSeconds: 1800,
  }).token;
  put(profilePath, profile);
  put('knowledge/personal/tenants/neighbor-fixture.json', {
    ...profile,
    tenant_slug: 'neighbor-fixture',
  });
  put('knowledge/personal/my-identity.json', { private: 'PRIVATE_IDENTITY_CANARY' });
  put(charterPath, charter);
  put(policyPath, { version: 1, mappings: [mapping] });
  put(
    mapping.pipeline.path,
    String(safeReadFile(path.join(sourceRoot, mapping.pipeline.path), { encoding: 'utf8' }))
  );
  safeRmSync(path.join(root, 'active/shared'), { recursive: true, force: true });
  const reservation = store.reserveConversationTurn(
    mapping.viewer,
    mapping.exactCommand,
    '00000000-0000-4000-8000-000000000001'
  );
  expect(reservation.routing?.kind).toBe('new_request');
  const entry = store.listConfiguredFrontDeskExecutions()[0];
  expect(entry?.binding).toBeDefined();
  proposal = execution.frontDeskExecutionProposal(entry.binding);
  callback = helper.createFirstJobTenantStatusAssertion(charter, mapping);
});
afterAll(() => {
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  safeRmSync(root, { recursive: true, force: true });
});

describe('first-job bound tenant status, real production authority', () => {
  it('checks one operational tenant under sentinel and restores the exact caller scope', () => {
    bound(() => {
      const scope = foundation.currentExecutionScope();
      expect(() => io.safeReadFile(path.join(root, profilePath))).toThrow();
      expect(authority.resolveIdentityContext()).toMatchObject({
        missionId: undefined,
        authorities: [],
        role: 'infrastructure_sentinel',
        persona: 'worker',
      });
      expect(
        store.inspectFrontDeskExecution(proposal.front_desk_execution!, charter)
      ).toMatchObject({ ok: true });
      expect(assertStatus()).toBeUndefined();
      expect(foundation.currentExecutionScope()).toEqual(scope);
      expect(authority.resolveRole()).toBe('infrastructure_sentinel');
      expect(authority.resolveExecutionPersona()).toBe('worker');
      expect(() => io.safeReadFile(path.join(root, profilePath))).toThrow();
      expect(
        dispatch.checkDotProposalBounds(charter, proposal, {
          rootDir: root,
          assertTenant: callback,
          countOpenWorkItems: () => 0,
        })
      ).toEqual({ ok: true });
    });
  });
  it('grants the new role only the bound record, without writes or neighboring personal reads', () => {
    authority.withExecutionContext(
      'first_job_tenant_status_reader',
      () => {
        expect(String(io.safeReadFile(path.join(root, profilePath)))).toContain(
          'PRIVATE_PROFILE_CANARY'
        );
        for (const file of [
          'knowledge/personal/tenants/neighbor-fixture.json',
          'knowledge/personal/my-identity.json',
        ])
          expect(() => io.safeReadFile(path.join(root, file))).toThrow();
        expect(() => io.safeWriteFile(path.join(root, profilePath), 'forbidden')).toThrow();
      },
      'worker',
      tenant
    );
    authority.withExecutionContext(
      'first_job_tenant_status_reader',
      () => {
        expect(() => io.safeReadFile(path.join(root, profilePath))).toThrow();
      },
      'worker'
    );
    vi.stubEnv('SYSTEM_ROLE', 'presence_studio');
    expect(() =>
      authority.withExecutionContext(
        'first_job_tenant_status_reader',
        () => undefined,
        'worker',
        tenant
      )
    ).toThrow('ROLE_ASSUMPTION_DENIED');
    vi.stubEnv('SYSTEM_ROLE', '');
  });
  it.each([
    { ...profile, status: 'suspended' },
    { ...profile, status: 'archived' },
    { ...profile, tenant_slug: 'neighbor-fixture' },
    { ...profile, status: 'PRIVATE_BAD_STATUS' },
    '{"private":"PRIVATE_PARSE_CANARY",',
  ])('sanitizes inactive, corrupt and mismatched registry records', (value) => {
    put(profilePath, value);
    bound(() => {
      const scope = foundation.currentExecutionScope();
      expect(assertStatus).toThrow(/^first_job_tenant_status_unavailable$/);
      expect(foundation.currentExecutionScope()).toEqual(scope);
      expect(authority.resolveRole()).toBe('infrastructure_sentinel');
      expect(authority.resolveExecutionPersona()).toBe('worker');
    });
  });
  it('fails closed for a missing record', () => {
    safeRmSync(path.join(root, profilePath));
    expect(() => bound(assertStatus)).toThrow(/^first_job_tenant_status_unavailable$/);
  });
  it('rejects wrong caller role, tenant, organization, unbound context and surface runtime', () => {
    expect(assertStatus).toThrow(/^first_job_tenant_status_unavailable$/);
    expect(() =>
      authority.withExecutionContext('infrastructure_sentinel', assertStatus, 'worker')
    ).toThrow('first_job_tenant_status_unavailable');
    expect(() => bound(assertStatus, 'neighbor-fixture')).toThrow(
      'first_job_tenant_status_unavailable'
    );
    expect(() => bound(assertStatus, tenant, 'wrong-org')).toThrow(
      'first_job_tenant_status_unavailable'
    );
    expect(() => bound(() => callback('neighbor-fixture', { charter, proposal }))).toThrow(
      'first_job_tenant_status_unavailable'
    );
    expect(() => bound(() => callback(tenant))).toThrow('first_job_tenant_status_unavailable');
    vi.stubEnv('SYSTEM_ROLE', 'presence_studio');
    expect(() => bound(assertStatus)).toThrow('first_job_tenant_status_unavailable');
    vi.stubEnv('SYSTEM_ROLE', '');
  });
  it('rejects ambient mission authority before entering the reader', () => {
    vi.stubEnv('MISSION_ID', 'MSN-UNRELATED-FIXTURE');
    expect(() => bound(assertStatus)).toThrow('first_job_tenant_status_unavailable');
    vi.stubEnv('MISSION_ID', '');
  });
  it('rejects fabricated or altered bindings despite a valid neighboring request', () => {
    proposal = {
      ...proposal,
      front_desk_execution: {
        ...proposal.front_desk_execution!,
        request_id: '00000000-0000-4000-8000-000000000099',
      },
    };
    expect(() => bound(assertStatus)).toThrow('first_job_tenant_status_unavailable');
  });
  it.each(['mapping', 'pipeline', 'charter', 'mode'])(
    'revalidates the current %s before reading status',
    (change) => {
      if (change === 'mapping') put(policyPath, { version: 1, mappings: [] });
      if (change === 'pipeline') put(mapping.pipeline.path, '{}');
      if (change === 'charter') put(charterPath, { ...charter, status: 'paused' });
      if (change === 'mode') proposal = { ...proposal, pipeline_ref: 'pipelines/other.json' };
      expect(() => bound(assertStatus)).toThrow('first_job_tenant_status_unavailable');
    }
  );
  it('preserves the exact durable binding through verified browser approval settlement and pre-effect revalidation', async () => {
    const work = await import('@agent/core/workforce/work-coordination');
    const captured: unknown[] = [];
    const deps: DotDispatchDeps = {
      rootDir: root,
      audit: () => undefined,
      notify: () => false,
      assertTenant: (slug, context) => {
        captured.push(context?.proposal.front_desk_execution);
        callback(slug, context);
      },
    };
    const parked = bound(() => dispatch.dispatchDotProposals(charter, [proposal], deps));
    expect(parked.records[0]?.status, parked.records[0]?.reason).toBe('parked');
    const session_id = store.conversationRef(mapping.viewer).sessionId;
    const review = approvalsFacade.readFirstJobApprovals(mapping.viewer, browserToken, {
      session_id,
    });
    expect(review.auth.status, JSON.stringify(review)).toBe('ready');
    const card = review.approvals.find(
      (entry) => entry.approval_request_id === parked.records[0].request_id
    )!;
    expect(card).toBeTruthy();
    const approved = approvalsFacade.decideFirstJobApproval(
      mapping.viewer,
      browserToken,
      card.approval_request_id,
      { decision: 'approved', display_digest: card.display_digest, session_id }
    );
    expect(approved.diagnosticDecision?.signature).toMatch(/^[a-f0-9]{64}$/);
    const settled = bound(() => dispatch.settleDotParkedActions(charter, deps));
    expect(settled[0]?.status, settled[0]?.reason).toBe('dispatched');
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(
      captured.every(
        (value) => JSON.stringify(value) === JSON.stringify(proposal.front_desk_execution)
      )
    ).toBe(true);
    const item = work.getWorkItem(proposal.front_desk_execution!.work_item_id)!;
    expect(item).toBeTruthy();
    expect(bound(() => execution.prepareFrontDeskExecution(charter, item, deps))).toMatchObject({
      tenant,
    });
    put(profilePath, { ...profile, status: 'suspended' });
    expect(() => bound(() => execution.prepareFrontDeskExecution(charter, item, deps))).toThrow(
      'first_job_tenant_status_unavailable'
    );
  });
  it('rejects a suspended tenant while settling an already signed browser approval', () => {
    const deps: DotDispatchDeps = {
      rootDir: root,
      assertTenant: callback,
      audit: () => undefined,
      notify: () => false,
    };
    const parked = bound(() => dispatch.dispatchDotProposals(charter, [proposal], deps));
    expect(parked.records[0]?.status, parked.records[0]?.reason).toBe('parked');
    const session_id = store.conversationRef(mapping.viewer).sessionId;
    const card = approvalsFacade.readFirstJobApprovals(mapping.viewer, browserToken, { session_id })
      .approvals[0];
    expect(card).toBeTruthy();
    approvalsFacade.decideFirstJobApproval(mapping.viewer, browserToken, card.approval_request_id, {
      decision: 'approved',
      display_digest: card.display_digest,
      session_id,
    });
    put(profilePath, { ...profile, status: 'suspended' });
    const create = vi.fn();
    const result = bound(() =>
      dispatch.settleDotParkedActions(charter, { ...deps, createWorkItem: create })
    );
    expect(result[0]?.status).toBe('declined');
    expect(result[0]?.reason).toContain('first_job_tenant_status_unavailable');
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves generic dispatch and leaves unattended diagnostic housekeeping inert', async () => {
    const spy = vi.fn(),
      generic = structuredClone(charter);
    delete generic.runtime.execution_mode;
    bound(() =>
      dispatch.checkDotProposalBounds(generic, proposal, {
        rootDir: root,
        assertTenant: spy,
        countOpenWorkItems: () => 0,
      })
    );
    expect(spy).toHaveBeenCalledWith(tenant, undefined);
    const approval = vi.fn();
    const result = await dispatch.runDotHousekeeping(charter, {
      rootDir: root,
      loadApproval: approval,
    });
    expect(result).toEqual({
      settled: [],
      signals: 0,
      digest: false,
      errors: ['diagnostic_requires_bounded_first_job_tick'],
    });
    expect(approval).not.toHaveBeenCalled();
  });
});
