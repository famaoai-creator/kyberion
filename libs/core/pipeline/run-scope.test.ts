import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  currentScopeEnvelope,
  mintScopeEnvelope,
  resetScopeEnvelopeState,
  withScopeEnvelope,
} from '../scope-envelope.js';
import { deriveRunScope, runScopeEnvelope } from './run-scope.js';

const ROOT = pathResolver.rootDir();
const FIXTURE_PARENT = path.join(ROOT, 'active', 'shared', 'tmp');
const TENANT = 'runscope-fixture';
const OTHER = 'runscope-other';

describe('deriveRunScope', () => {
  let fixtureRoot = '';

  function seedProfile(slug: string, status: 'active' | 'suspended' = 'active'): void {
    const dir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      path.join(dir, `${slug}.json`),
      JSON.stringify({
        tenant_slug: slug,
        display_name: `Tenant ${slug}`,
        status,
        assigned_role: 'owner',
      })
    );
  }

  const options = (env: NodeJS.ProcessEnv = {}) => ({
    env,
    registry: { rootDir: fixtureRoot, env: {} as NodeJS.ProcessEnv },
  });

  beforeEach(() => {
    fixtureRoot = path.join(
      FIXTURE_PARENT,
      `run-scope-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    resetScopeEnvelopeState();
  });

  afterEach(() => {
    if (fixtureRoot) safeRmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = '';
  });

  it('derives tier and tenant from a tenant knowledge location', () => {
    seedProfile(TENANT);
    const scope = deriveRunScope(`knowledge/confidential/${TENANT}/flows/run.json`, options());
    expect(scope).toEqual({
      input_path: `knowledge/confidential/${TENANT}/flows/run.json`,
      tier: 'confidential',
      tenant_slug: TENANT,
      source: 'location',
    });
  });

  it('keeps the ambient scope for repository-owned pipelines', () => {
    const scope = deriveRunScope(
      'pipelines/baseline-check.json',
      options({ KYBERION_TENANT: OTHER })
    );
    expect(scope).toEqual({
      input_path: 'pipelines/baseline-check.json',
      tier: 'public',
      source: 'ambient',
      ambient_tenant_slug: OTHER,
    });
    expect(deriveRunScope('knowledge/product/pipeline-templates/x.json', options()).source).toBe(
      'ambient'
    );
  });

  it('runs a chronos tenant-runner child (KYBERION_TENANT bound to the same tenant)', () => {
    seedProfile(TENANT);
    // chronos_daemon tenantRunEnv: KYBERION_TENANT + KYBERION_TENANT_SCOPE_REQUIRED=1, no parent envelope.
    const env = { KYBERION_TENANT: TENANT, KYBERION_TENANT_SCOPE_REQUIRED: '1' };
    const scope = deriveRunScope(
      `knowledge/confidential/${TENANT}/pipelines/digest.json`,
      options(env)
    );
    expect(scope).toMatchObject({ tenant_slug: TENANT, source: 'location' });
    const envelope = runScopeEnvelope(scope, { session_id: 'pipeline:chronos', purpose: 'p', env });
    expect(envelope?.identity.tenant_slug).toBe(TENANT);
  });

  it('accepts an equal ambient tenant and rejects a different one', () => {
    seedProfile(TENANT);
    const file = `knowledge/confidential/${TENANT}/run.json`;
    expect(deriveRunScope(file, options({ KYBERION_TENANT: TENANT })).tenant_slug).toBe(TENANT);
    expect(() => deriveRunScope(file, options({ KYBERION_TENANT: OTHER }))).toThrow(
      /^\[RUN_SCOPE_MISMATCH\] .* — .* \| next: unset KYBERION_TENANT or move the pipeline$/u
    );
  });

  it('fails closed for unregistered, inactive and unattributable locations', () => {
    expect(() => deriveRunScope(`knowledge/confidential/${TENANT}/run.json`, options())).toThrow(
      /\[RUN_SCOPE_TENANT_UNKNOWN\]/u
    );
    seedProfile(TENANT, 'suspended');
    expect(() => deriveRunScope(`knowledge/confidential/${TENANT}/run.json`, options())).toThrow(
      /\[RUN_SCOPE_TENANT_INACTIVE\]/u
    );
    expect(() => deriveRunScope('knowledge/confidential/Not_A_Slug/run.json', options())).toThrow(
      /\[RUN_SCOPE_UNRESOLVED\]/u
    );
  });

  it('keeps tenant-less personal and shared-prefix locations on the ambient scope', () => {
    expect(deriveRunScope('knowledge/personal/flows/run.json', options())).toMatchObject({
      tier: 'personal',
      source: 'ambient',
    });
    expect(
      deriveRunScope('knowledge/confidential/tenant-groups/run.json', options())
    ).toMatchObject({ tier: 'confidential', source: 'ambient' });
  });
});

describe('runScopeEnvelope', () => {
  beforeEach(() => resetScopeEnvelopeState());

  const scope = {
    input_path: `knowledge/confidential/${TENANT}/run.json`,
    tier: 'confidential' as const,
    tenant_slug: TENANT,
    source: 'location' as const,
  };

  it('mints a tenant-bound session envelope for a top-level run', () => {
    const envelope = runScopeEnvelope(scope, {
      session_id: 'pipeline:test-run',
      purpose: 'pipeline test',
      env: {},
    });
    expect(envelope?.identity).toMatchObject({
      tier: 'confidential',
      tenant_slug: TENANT,
      session_id: 'pipeline:test-run',
    });
    expect(envelope?.policy.purpose).toBe('pipeline test');
    const seen = withScopeEnvelope(envelope!, () => currentScopeEnvelope()?.identity.tenant_slug);
    expect(seen).toBe(TENANT);
  });

  it('keeps the ambient scope when no tenant is derived', () => {
    expect(
      runScopeEnvelope(
        { input_path: 'pipelines/x.json', tier: 'public', source: 'ambient' },
        { session_id: 'pipeline:x', purpose: 'p', env: {} }
      )
    ).toBeUndefined();
  });

  it('lets a nested run stay inside a same-tenant parent and rejects a different tenant', () => {
    const parent = mintScopeEnvelope({
      identity: { tier: 'confidential', tenant_slug: TENANT, session_id: 'parent' },
      policy: { purpose: 'parent' },
      env: {},
    });
    expect(runScopeEnvelope(scope, { parent, session_id: 's', purpose: 'p' })).toBeUndefined();
    const otherParent = mintScopeEnvelope({
      identity: { tier: 'confidential', tenant_slug: OTHER, session_id: 'parent' },
      policy: { purpose: 'parent' },
      env: {},
    });
    expect(() =>
      runScopeEnvelope(scope, { parent: otherParent, session_id: 's', purpose: 'p' })
    ).toThrow(/\[RUN_SCOPE_MISMATCH\] nested pipeline/u);
  });

  it('binds the derived tenant under a tenant-less daemon / Dot parent (narrowing)', () => {
    // chronos / Dot library runs execute under a mission-less, tenant-less
    // session envelope; the tenant pipeline's own registered tenant narrows it.
    const parent = mintScopeEnvelope({
      identity: { tier: 'public', session_id: 'dot-session' },
      policy: { purpose: 'dot wake', external_egress: 'deny' },
      env: {},
    });
    const envelope = runScopeEnvelope(scope, {
      parent,
      session_id: 'pipeline:r1',
      purpose: 'p',
      env: {},
    });
    expect(envelope?.identity).toMatchObject({
      tier: 'confidential',
      tenant_slug: TENANT,
      session_id: 'pipeline:r1',
    });
    // The parent's egress limit carries over; it is never widened.
    expect(envelope?.policy.external_egress).toBe('deny');
  });

  it('never adds a tenant a parent mission record does not anchor', () => {
    const parent = mintScopeEnvelope({
      identity: { tier: 'public', mission_id: 'MSN-RUNSCOPE-UNANCHORED' },
      policy: { purpose: 'parent' },
      env: {},
    });
    expect(() => runScopeEnvelope(scope, { parent, session_id: 's', purpose: 'p' })).toThrow(
      /\[RUN_SCOPE_MISMATCH\]/u
    );
  });
});
