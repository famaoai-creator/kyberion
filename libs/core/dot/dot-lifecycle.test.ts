import { afterEach, describe, expect, it } from 'vitest';

import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import { loadDotCharter, FRONT_DESK_DIAGNOSTIC_PIPELINE, type DotCharter } from './dot-charter.js';
import { saveOrganizationOperationalState } from '../organization/organization-operating-model-persistence.js';
import { saveOrganizationOperation } from '../organization/organization-operating-model-operations.js';
import { dotAdmissionScopeHash } from './dot-admission-identity.js';
import * as path from 'node:path';
import {
  DOT_LIFECYCLE_AUDIT_PATH,
  createDraftDotCharter,
  checkDotActivationReadiness,
  isDotStatusTerminal,
  transitionDotCharterStatus,
  configureDotDelegationCapacity,
} from './dot-lifecycle.js';

const TEST_ROOT = 'active/shared/tmp/dot-lifecycle-tests';

const DRAFT: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'repo-guardian',
  version: '1.0.0',
  title: 'Repo guardian',
  purpose: 'Keep the repository healthy.',
  status: 'draft',
  scope: { tier: 'public' },
  goal: { statement: 'Keep CI green.' },
  attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
  authority: { authority_role: 'infrastructure_sentinel' },
  notification: { deliver_to: { surface: 'slack', channel: '#ops' } },
  runtime: { heartbeat_id: 'dot-repo-guardian' },
};

const KNOWN_ROLES = new Set(['infrastructure_sentinel']);
const deps = {
  rootDir: TEST_ROOT,
  hasRole: (role: string) => KNOWN_ROLES.has(role),
  supervisedDaemonIds: ['chronos-daemon', 'agent-runtime-supervisor-daemon'],
};

function writeCharter(charter: unknown, name = 'dot.json'): string {
  safeMkdir(`${TEST_ROOT}/dots`, { recursive: true });
  const filePath = `${TEST_ROOT}/dots/${name}`;
  safeWriteFile(filePath, JSON.stringify(charter, null, 2) + '\n');
  return filePath;
}

function writeTenantCharter(slug: string, charter: DotCharter, name = 'dot.json'): string {
  const profiles = `${TEST_ROOT}/knowledge/personal/tenants`;
  safeMkdir(profiles, { recursive: true });
  safeWriteFile(
    `${profiles}/${slug}.json`,
    JSON.stringify({
      tenant_slug: slug,
      display_name: slug,
      status: 'active',
      assigned_role: 'owner',
    })
  );
  const dir = `${TEST_ROOT}/knowledge/confidential/${slug}/dots`;
  safeMkdir(dir, { recursive: true });
  const filePath = `${dir}/${name}`;
  safeWriteFile(
    filePath,
    JSON.stringify({
      ...charter,
      scope: { tier: 'confidential', tenant_slug: slug },
    })
  );
  return filePath;
}

afterEach(() => {
  safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('configureDotDelegationCapacity', () => {
  it('previews and changes only capacity on a paused charter, then supports inheritance', () => {
    const file = writeCharter({ ...DRAFT, status: 'paused' });
    const preview = configureDotDelegationCapacity(DRAFT.dot_id, 100, { ...deps, dryRun: true });
    expect(preview).toMatchObject({ applied: false, effective_limit: 100 });
    expect(loadDotCharter(file).authority.max_concurrent_delegations).toBeUndefined();
    const applied = configureDotDelegationCapacity(DRAFT.dot_id, 100, deps);
    expect(applied.charter).toEqual({
      ...DRAFT,
      status: 'paused',
      authority: {
        ...DRAFT.authority,
        max_concurrent_delegations: 100,
      },
    });
    expect(loadDotCharter(file).authority.max_concurrent_delegations).toBe(100);
    configureDotDelegationCapacity(DRAFT.dot_id, undefined, deps);
    expect(loadDotCharter(file).authority.max_concurrent_delegations).toBeUndefined();
    expect(safeExistsSync(`${TEST_ROOT}/${DOT_LIFECYCLE_AUDIT_PATH}`)).toBe(true);
  });
  it('refuses active/retired changes and invalid limits without modifying the charter', () => {
    for (const status of ['active', 'retired'] as const) {
      const file = writeCharter({ ...DRAFT, status });
      expect(() => configureDotDelegationCapacity(DRAFT.dot_id, 100, deps)).toThrow(
        'pause the dot'
      );
      expect(loadDotCharter(file).status).toBe(status);
      expect(loadDotCharter(file).authority.max_concurrent_delegations).toBeUndefined();
    }
    writeCharter(DRAFT);
    for (const limit of [0, -1, 3.5, 257, Infinity, NaN]) {
      expect(() => configureDotDelegationCapacity(DRAFT.dot_id, limit, deps)).toThrow(
        'DOT_CAPACITY_INVALID'
      );
    }
  });
});

describe('transitionDotCharterStatus', () => {
  it.each(['active', 'paused', 'retired'] as const)(
    'rejects ambiguous identity before a %s transition or any write',
    (target) => {
      const status = target === 'active' ? 'draft' : 'active';
      const repoPath = writeCharter({ ...DRAFT, status });
      const secondPath = writeCharter({ ...DRAFT, status }, 'second.json');
      expect(() => transitionDotCharterStatus(DRAFT.dot_id, target, deps)).toThrow(
        /Duplicate dot_id 'repo-guardian'/
      );
      expect(loadDotCharter(repoPath).status).toBe(status);
      expect(loadDotCharter(secondPath).status).toBe(status);
      expect(safeExistsSync(`${TEST_ROOT}/${DOT_LIFECYCLE_AUDIT_PATH}`)).toBe(false);
    }
  );

  it('transitions the repo owner of an id a tenant duplicate reuses, leaving the duplicate', () => {
    const repoPath = writeCharter(DRAFT);
    const tenantPath = writeTenantCharter('acme', { ...DRAFT, status: 'draft' });
    expect(transitionDotCharterStatus(DRAFT.dot_id, 'active', deps).status).toBe('active');
    expect(loadDotCharter(repoPath).status).toBe('active');
    expect(loadDotCharter(tenantPath).status).toBe('draft');
  });

  it('transitions only the owner of an identity shared by two tenants', () => {
    const first = writeTenantCharter('acme', { ...DRAFT, status: 'active' });
    const second = writeTenantCharter('globex', { ...DRAFT, status: 'active' });
    // No lifecycle history: the earliest-activated established charter owns the id.
    expect(transitionDotCharterStatus(DRAFT.dot_id, 'paused', deps).status).toBe('paused');
    expect(loadDotCharter(first).status).toBe('paused');
    expect(loadDotCharter(second).status).toBe('active');
  });

  it('rejects a transition for an identity two files in one tenant declare', () => {
    const first = writeTenantCharter('acme', { ...DRAFT, status: 'active' });
    const second = writeTenantCharter('acme', { ...DRAFT, status: 'active' }, 'second.json');
    expect(() => transitionDotCharterStatus(DRAFT.dot_id, 'paused', deps)).toThrow(
      /Duplicate dot_id 'repo-guardian'/
    );
    expect(loadDotCharter(first).status).toBe('active');
    expect(loadDotCharter(second).status).toBe('active');
    expect(safeExistsSync(`${TEST_ROOT}/${DOT_LIFECYCLE_AUDIT_PATH}`)).toBe(false);
  });

  it('still transitions an unambiguous tenant charter beside malformed and colliding siblings', () => {
    writeCharter({ ...DRAFT, dot_id: 'collision' }, 'one.json');
    writeCharter({ ...DRAFT, dot_id: 'collision' }, 'two.json');
    writeCharter({ ...DRAFT, bogus: true }, 'broken.json');
    const filePath = writeTenantCharter('acme', { ...DRAFT, dot_id: 'unique', status: 'active' });
    expect(transitionDotCharterStatus('unique', 'paused', deps).status).toBe('paused');
    expect(loadDotCharter(filePath).status).toBe('paused');
  });

  it('activates a draft charter when the gate passes', () => {
    const filePath = writeCharter({ ...DRAFT, $schema: '../schema.json' });
    const updated = transitionDotCharterStatus('repo-guardian', 'active', deps);
    expect(updated.status).toBe('active');
    // The on-disk file retains $schema and the new status.
    expect(loadDotCharter(filePath).status).toBe('active');
    expect(safeExistsSync(`${TEST_ROOT}/${DOT_LIFECYCLE_AUDIT_PATH}`)).toBe(true);
  });

  it('rejects activation when the authority role is not in the registry', () => {
    writeCharter({ ...DRAFT, authority: { authority_role: 'ghost_role' } });
    expect(() => transitionDotCharterStatus('repo-guardian', 'active', deps)).toThrow(
      /DOT_ACTIVATE_ROLE.*ghost_role/
    );
    expect(loadDotCharter(`${TEST_ROOT}/dots/dot.json`).status).toBe('draft');
  });

  it('rejects activation when the heartbeat id collides with a supervised daemon', () => {
    writeCharter({ ...DRAFT, runtime: { heartbeat_id: 'chronos-daemon' } });
    expect(() => transitionDotCharterStatus('repo-guardian', 'active', deps)).toThrow(
      /DOT_ACTIVATE_HEARTBEAT/
    );
  });

  it('rejects activation when the heartbeat id is used by another active dot', () => {
    writeCharter({ ...DRAFT, status: 'active' }, 'one.json');
    writeCharter({ ...DRAFT, dot_id: 'second-dot' }, 'two.json');
    expect(() => transitionDotCharterStatus('second-dot', 'active', deps)).toThrow(
      /DOT_ACTIVATE_HEARTBEAT.*repo-guardian/
    );
  });

  it('rejects activation while another active dot holds the same responsibility', () => {
    writeCharter(
      { ...DRAFT, status: 'active', team: { responsibilities: ['ci.health', 'deps'] } },
      'one.json'
    );
    writeCharter(
      {
        ...DRAFT,
        dot_id: 'second-dot',
        runtime: { heartbeat_id: 'dot-second' },
        team: { responsibilities: ['deps'] },
      },
      'two.json'
    );
    expect(() => transitionDotCharterStatus('second-dot', 'active', deps)).toThrow(
      /DOT_ACTIVATE_RESPONSIBILITY.*deps.*repo-guardian/
    );
    writeCharter(
      {
        ...DRAFT,
        dot_id: 'second-dot',
        runtime: { heartbeat_id: 'dot-second' },
        team: { responsibilities: ['releases'] },
      },
      'two.json'
    );
    expect(transitionDotCharterStatus('second-dot', 'active', deps).status).toBe('active');
  });

  it('allows pause and re-activation, forbids retiring a retired dot', () => {
    writeCharter({ ...DRAFT, status: 'active' });
    expect(transitionDotCharterStatus('repo-guardian', 'paused', deps).status).toBe('paused');
    expect(transitionDotCharterStatus('repo-guardian', 'active', deps).status).toBe('active');
    transitionDotCharterStatus('repo-guardian', 'retired', deps);
    expect(isDotStatusTerminal('retired')).toBe(true);
    expect(() => transitionDotCharterStatus('repo-guardian', 'active', deps)).toThrow(
      /DOT_TRANSITION/
    );
  });

  it('rejects draft → paused directly and unknown dots', () => {
    writeCharter(DRAFT);
    expect(() => transitionDotCharterStatus('repo-guardian', 'paused', deps)).toThrow(
      /DOT_TRANSITION/
    );
    expect(() => transitionDotCharterStatus('nope', 'active', deps)).toThrow(/DOT_NOT_FOUND/);
  });
});

describe('checkDotActivationReadiness', () => {
  it('reports an ownerless duplicate identity as an activation blocker', () => {
    writeCharter(DRAFT);
    writeCharter(DRAFT, 'second.json');
    expect(checkDotActivationReadiness(DRAFT, deps)).toMatchObject({
      ready: false,
      errors: [expect.stringContaining("Duplicate dot_id 'repo-guardian'")],
    });
  });

  it('blocks a rejected duplicate but not the owner of its id', () => {
    writeCharter(DRAFT);
    writeTenantCharter('acme', { ...DRAFT, status: 'retired' });
    expect(checkDotActivationReadiness(DRAFT, deps)).toEqual({ ready: true, errors: [] });
    const duplicate: DotCharter = {
      ...DRAFT,
      status: 'retired',
      scope: { tier: 'confidential', tenant_slug: 'acme' },
    };
    expect(checkDotActivationReadiness(duplicate, deps)).toMatchObject({
      ready: false,
      errors: [expect.stringContaining('[DOT_IDENTITY]')],
    });
  });

  it('reports gate errors without mutating the charter', () => {
    writeCharter({ ...DRAFT, authority: { authority_role: 'ghost_role' } });
    const check = checkDotActivationReadiness(
      { ...DRAFT, authority: { authority_role: 'ghost_role' } },
      deps
    );
    expect(check.ready).toBe(false);
    expect(check.errors[0]).toContain('ghost_role');
  });
});

describe('create public draft charter', () => {
  it('keeps strict tenant-owned diagnostics public without admitting arbitrary public tenant drafts', () => {
    writeTenantCharter('diagnostic-tenant', { ...DRAFT, dot_id: 'seed' });
    const diagnostic = {
      ...DRAFT,
      scope: { tier: 'public' as const, tenant_slug: 'diagnostic-tenant' },
      attention: { triggers: [] },
      authority: {
        authority_role: 'infrastructure_sentinel',
        allowed_work_shapes: ['pipeline' as const],
        allowed_pipelines: [FRONT_DESK_DIAGNOSTIC_PIPELINE],
      },
      decisions: { default_decision: 'approve' as const, escalate_channel: 'surface' },
      notification: {
        delivery_mode: 'inbox' as const,
        deliver_to: { surface: 'surface', channel: 'inbox' },
      },
      runtime: { ...DRAFT.runtime, execution_mode: 'front_desk_diagnostic' as const },
    };
    expect(() => createDraftDotCharter({ ...DRAFT, scope: diagnostic.scope }, deps)).toThrow(
      'Invalid front_desk_diagnostic'
    );
    const created = createDraftDotCharter(diagnostic, deps);
    expect(created.scope).toEqual(diagnostic.scope);
    expect(safeExistsSync(`${TEST_ROOT}/dots/${DRAFT.dot_id}.json`)).toBe(true);
    expect(
      safeExistsSync(
        `${TEST_ROOT}/knowledge/confidential/diagnostic-tenant/dots/${DRAFT.dot_id}.json`
      )
    ).toBe(false);
  });
  it('requires actual public organization ownership rather than trusting a public label', () => {
    writeTenantCharter('public-owner', { ...DRAFT, dot_id: 'seed' });
    const state = {
      organization_id: 'public-org',
      name: 'Public org',
      tier: 'public' as const,
      tenant_slug: 'public-owner',
      status: 'active' as const,
      updated_at: '2026-10-21T00:00:00Z',
    };
    saveOrganizationOperationalState(state, { rootDir: path.resolve(TEST_ROOT) });
    const draft = {
      ...DRAFT,
      scope: {
        tier: 'public' as const,
        tenant_slug: 'public-owner',
        organization_id: 'public-org',
      },
    };
    expect(createDraftDotCharter(draft, { ...deps, dryRun: true }).scope).toEqual(draft.scope);
    saveOrganizationOperationalState(
      { ...state, organization_id: 'private-only', tier: 'confidential' },
      { rootDir: path.resolve(TEST_ROOT) }
    );
    expect(() =>
      createDraftDotCharter(
        { ...draft, scope: { ...draft.scope, organization_id: 'private-only' } },
        { ...deps, dryRun: true }
      )
    ).toThrow();
    expect(safeExistsSync(`${TEST_ROOT}/dots/${DRAFT.dot_id}.json`)).toBe(false);
  });
  it('validates an operation parent at authoring and activation and rejects stale rebinding under lock', () => {
    const tenant = 'workspace-tenant';
    const organization = 'workspace-org';
    const operation = 'weekly-report';
    writeTenantCharter(tenant, { ...DRAFT, dot_id: 'seed' });
    const rootDir = path.resolve(TEST_ROOT);
    const updated_at = '2026-10-21T00:00:00Z';
    saveOrganizationOperationalState(
      {
        organization_id: organization,
        name: organization,
        tier: 'confidential',
        tenant_slug: tenant,
        status: 'active',
        updated_at,
      },
      { rootDir }
    );
    saveOrganizationOperation(
      {
        version: '1.0.0',
        operation_id: operation,
        organization_id: organization,
        name: operation,
        operation_type: 'scheduled',
        owner_role: 'infrastructure_sentinel',
        trigger: { kind: 'schedule', expression: '0 9 * * *', timezone: 'UTC' },
        automation_boundary: {
          allowed_actions: [],
          approval_required_actions: [],
          forbidden_actions: [],
        },
        escalation_path: ['operator'],
        evidence_outputs: ['report'],
        execution_target: { kind: 'pipeline', ref: 'pipelines/ok.json' },
        tier: 'confidential',
        tenant_slug: tenant,
        status: 'active',
        updated_at,
      },
      { rootDir }
    );
    const bound = {
      ...DRAFT,
      scope: { tier: 'confidential' as const, tenant_slug: tenant, organization_id: organization },
      work_binding: { operation_id: operation },
    };
    expect(() =>
      createDraftDotCharter({ ...bound, work_binding: { operation_id: 'missing' } }, deps)
    ).toThrow('WORKSPACE_SCOPE_UNAVAILABLE');
    createDraftDotCharter(bound, deps);
    expect(transitionDotCharterStatus(bound.dot_id, 'active', deps).status).toBe('active');
    const paused = transitionDotCharterStatus(bound.dot_id, 'paused', deps);
    const file = `${rootDir}/knowledge/confidential/${tenant}/dots/${bound.dot_id}.json`;
    safeWriteFile(
      file,
      JSON.stringify({ ...paused, work_binding: { operation_id: 'other-operation' } })
    );
    expect(() =>
      transitionDotCharterStatus(bound.dot_id, 'active', {
        ...deps,
        expectedAdmissionScopeHash: dotAdmissionScopeHash(paused),
      })
    ).toThrow('DOT_TRANSITION_CONFLICT');
    expect(loadDotCharter(file).status).toBe('paused');
  });
  it('creates a registered tenant draft in its confidential source and runs the real lifecycle', () => {
    writeTenantCharter('workspace-tenant', { ...DRAFT, dot_id: 'seed' });
    const scoped = {
      ...DRAFT,
      scope: { tier: 'confidential' as const, tenant_slug: 'workspace-tenant' },
    };
    const result = createDraftDotCharter(scoped, deps);
    const source = `${TEST_ROOT}/knowledge/confidential/workspace-tenant/dots/${DRAFT.dot_id}.json`;
    expect(result.scope).toEqual(scoped.scope);
    expect(loadDotCharter(source).status).toBe('draft');
    expect(safeExistsSync(`${TEST_ROOT}/dots/${DRAFT.dot_id}.json`)).toBe(false);
    expect(transitionDotCharterStatus(DRAFT.dot_id, 'active', deps).status).toBe('active');
    expect(transitionDotCharterStatus(DRAFT.dot_id, 'paused', deps).status).toBe('paused');
    expect(transitionDotCharterStatus(DRAFT.dot_id, 'active', deps).status).toBe('active');
  });
  it('creates a complete draft and leaves activation explicit', () => {
    const value = createDraftDotCharter(DRAFT, deps);
    expect(value.status).toBe('draft');
    expect(loadDotCharter(TEST_ROOT + '/dots/' + DRAFT.dot_id + '.json').status).toBe('draft');
    expect(transitionDotCharterStatus(DRAFT.dot_id, 'active', deps).status).toBe('active');
  });
  it('does not overwrite an existing identity or destination', () => {
    writeCharter(DRAFT, 'different-file.json');
    expect(() => createDraftDotCharter(DRAFT, deps)).toThrow('DOT_CREATE_EXISTS');
    expect(safeExistsSync(TEST_ROOT + '/dots/' + DRAFT.dot_id + '.json')).toBe(false);
  });
  it('rejects active creation and an unregistered tenant', () => {
    expect(() => createDraftDotCharter({ ...DRAFT, status: 'active' }, deps)).toThrow(
      'DOT_CREATE_DRAFT'
    );
    expect(() =>
      createDraftDotCharter(
        { ...DRAFT, scope: { tier: 'confidential', tenant_slug: 'test-tenant' } },
        deps
      )
    ).toThrow();
  });
  it('does not replace a draft on a repeated create', () => {
    createDraftDotCharter(DRAFT, deps);
    expect(() => createDraftDotCharter({ ...DRAFT, title: 'changed' }, deps)).toThrow(
      'DOT_CREATE_EXISTS'
    );
    expect(loadDotCharter(TEST_ROOT + '/dots/' + DRAFT.dot_id + '.json').title).toBe(DRAFT.title);
  });
});
