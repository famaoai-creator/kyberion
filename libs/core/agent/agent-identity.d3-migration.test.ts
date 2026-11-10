import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { logger } from '../core.js';
import {
  AGENT_IDENTITY_OPS,
  AgentIdentityFormatError,
  AgentIdentityJournal,
  applyAgentIdentityIdMigration,
  canonicalAgentNhiId,
  ensureAgentIdentityProvisioned,
  getAgentIdentity,
  issueAgentIdentity,
  listAgentIdentities,
  planAgentIdentityIdMigration,
  resetAgentIdentityServiceForTests,
  resetLegacyNhiIdWarningsForTests,
  suspendAgentIdentity,
} from './agent-identity.js';

/**
 * Concept model v2 D3 / S3: the NHI id carries the tenant
 * (`kyberion://agent/<tenant>/<org|_>/<slug>`), the 'default' organization
 * fallback is gone, and legacy `kyberion://agent/<org>/<slug>` ids resolve as
 * aliases for one release after `pnpm nhi migrate-ids`.
 */

const TMP_DIR = `active/shared/tmp/ni01-d3-tests-${process.pid}`;
let counter = 0;
let journalPath = '';
let previousTenant: string | undefined;

beforeEach(() => {
  previousTenant = process.env.KYBERION_TENANT;
  delete process.env.KYBERION_TENANT;
  counter += 1;
  journalPath = `${TMP_DIR}/agent-identities-${counter}.jsonl`;
  resetAgentIdentityServiceForTests(journalPath);
  resetLegacyNhiIdWarningsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousTenant === undefined) delete process.env.KYBERION_TENANT;
  else process.env.KYBERION_TENANT = previousTenant;
  resetAgentIdentityServiceForTests();
});

afterAll(() => {
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
});

const asController = <T>(fn: () => T): T => withExecutionContext('mission_controller', fn);

/** A pre-D3 ledger record, written the way the old issuer wrote it. */
function seedLegacyIdentity(
  nhiId: string,
  affiliation: Record<string, string>,
  createdAt = '2026-07-26T00:00:00.000Z'
): void {
  new AgentIdentityJournal({ journalPath }).append(AGENT_IDENTITY_OPS.identityProvisioned, {
    nhi_id: nhiId,
    kind: 'agent',
    display_name: nhiId.split('/').pop(),
    accountable_human_id: 'user:owner',
    affiliation,
    created_at: createdAt,
  });
}

describe('agent-identity — D3 issuance', () => {
  it('issues kyberion://agent/<tenant>/<org>/<slug> and records the tenant', () => {
    const record = asController(() =>
      issueAgentIdentity({
        kind: 'agent',
        tenantSlug: 'acme',
        organizationId: 'sales',
        slug: 'planner',
        accountableHumanId: 'user:owner',
      })
    );
    expect(record.nhi_id).toBe('kyberion://agent/acme/sales/planner');
    expect(record.affiliation).toEqual({ organization_id: 'sales', tenant_slug: 'acme' });
  });

  it('writes _ for an NHI with no organization, never the old default fallback', () => {
    const record = asController(() =>
      issueAgentIdentity({
        kind: 'agent',
        tenantSlug: 'acme',
        slug: 'planner',
        accountableHumanId: 'user:owner',
      })
    );
    expect(record.nhi_id).toBe('kyberion://agent/acme/_/planner');
    expect(record.nhi_id).not.toContain('/default/');
  });

  it('takes the tenant from the active tenant when none is passed', () => {
    process.env.KYBERION_TENANT = 'globex';
    const record = asController(() =>
      issueAgentIdentity({
        kind: 'agent',
        organizationId: 'ops',
        slug: 'planner',
        accountableHumanId: 'user:owner',
      })
    );
    expect(record.nhi_id).toBe('kyberion://agent/globex/ops/planner');
  });

  it('rejects an organization-scoped NHI without a tenant', () => {
    expect(() =>
      asController(() =>
        issueAgentIdentity({
          kind: 'agent',
          organizationId: 'sales',
          slug: 'planner',
          accountableHumanId: 'user:owner',
        })
      )
    ).toThrow(/tenant slug is required/);
    expect(listAgentIdentities()).toEqual([]);
  });

  it('rejects a reserved scope name as the tenant', () => {
    for (const reserved of ['public', 'confidential', 'personal', 'shared']) {
      expect(() =>
        asController(() =>
          issueAgentIdentity({
            kind: 'agent',
            tenantSlug: reserved,
            slug: 'planner',
            accountableHumanId: 'user:owner',
          })
        )
      ).toThrow(AgentIdentityFormatError);
    }
    expect(listAgentIdentities()).toEqual([]);
  });

  it('a person-scope identity never inherits the ambient tenant', () => {
    process.env.KYBERION_TENANT = 'globex';
    const record = asController(() =>
      ensureAgentIdentityProvisioned({
        slug: 'haru',
        personScope: true,
        accountableHumanId: 'user:owner',
      })
    );
    expect(record.nhi_id).toBe('kyberion://agent/_/_/haru');
    expect(record.affiliation.tenant_slug).toBeUndefined();
  });
});

describe('agent-identity — legacy id migration and aliases', () => {
  it('plans without writing, applies once, and is idempotent', () => {
    seedLegacyIdentity('kyberion://agent/sales/planner', {
      organization_id: 'sales',
      tenant_slug: 'acme',
    });
    seedLegacyIdentity(
      'kyberion://agent/default/haru',
      { organization_id: 'default' },
      '2026-07-27T00:00:00.000Z'
    );

    const plan = planAgentIdentityIdMigration();
    expect(plan.map((entry) => [entry.legacy_nhi_id, entry.nhi_id, entry.status])).toEqual([
      ['kyberion://agent/sales/planner', 'kyberion://agent/acme/sales/planner', 'migrate'],
      ['kyberion://agent/default/haru', 'kyberion://agent/_/_/haru', 'migrate'],
    ]);
    // Dry run wrote nothing: the ledger is still keyed by the legacy ids.
    expect(listAgentIdentities().map((record) => record.nhi_id)).toEqual([
      'kyberion://agent/sales/planner',
      'kyberion://agent/default/haru',
    ]);

    asController(() => applyAgentIdentityIdMigration());
    expect(listAgentIdentities().map((record) => record.nhi_id)).toEqual([
      'kyberion://agent/acme/sales/planner',
      'kyberion://agent/_/_/haru',
    ]);
    expect(getAgentIdentity('kyberion://agent/_/_/haru')?.affiliation.organization_id).toBe('_');

    // Second run: nothing left to migrate, no new journal events.
    expect(planAgentIdentityIdMigration()).toEqual([]);
    expect(asController(() => applyAgentIdentityIdMigration())).toEqual([]);
  });

  it('resolves an old id as an alias of the migrated record and logs the deprecation once', () => {
    seedLegacyIdentity('kyberion://agent/sales/planner', {
      organization_id: 'sales',
      tenant_slug: 'acme',
    });
    asController(() => applyAgentIdentityIdMigration());
    const warn = vi.spyOn(logger, 'warn');

    const viaAlias = getAgentIdentity('kyberion://agent/sales/planner');
    expect(viaAlias?.nhi_id).toBe('kyberion://agent/acme/sales/planner');
    getAgentIdentity('kyberion://agent/sales/planner');
    expect(canonicalAgentNhiId('kyberion://agent/sales/planner')).toBe(
      'kyberion://agent/acme/sales/planner'
    );
    const deprecations = warn.mock.calls.filter(([line]) =>
      String(line).includes('legacy nhi_id kyberion://agent/sales/planner')
    );
    expect(deprecations).toHaveLength(1);

    // Writes through an old id land on the canonical record.
    const suspended = asController(() => suspendAgentIdentity('kyberion://agent/sales/planner'));
    expect(suspended.nhi_id).toBe('kyberion://agent/acme/sales/planner');
    expect(getAgentIdentity('kyberion://agent/acme/sales/planner')?.lifecycle_status).toBe(
      'suspended'
    );
  });

  it('before migration, the canonical id finds the legacy record instead of re-issuing it', () => {
    seedLegacyIdentity('kyberion://agent/sales/planner', {
      organization_id: 'sales',
      tenant_slug: 'acme',
    });
    expect(getAgentIdentity('kyberion://agent/acme/sales/planner')?.nhi_id).toBe(
      'kyberion://agent/sales/planner'
    );
    const ensured = asController(() =>
      ensureAgentIdentityProvisioned({
        slug: 'planner',
        tenantSlug: 'acme',
        organizationId: 'sales',
        accountableHumanId: 'user:owner',
      })
    );
    expect(ensured.nhi_id).toBe('kyberion://agent/sales/planner');
    expect(listAgentIdentities()).toHaveLength(1);
  });

  it('skips a legacy record whose canonical id is already taken', () => {
    seedLegacyIdentity('kyberion://agent/sales/planner', {
      organization_id: 'sales',
      tenant_slug: 'acme',
    });
    new AgentIdentityJournal({ journalPath }).append(AGENT_IDENTITY_OPS.identityProvisioned, {
      nhi_id: 'kyberion://agent/acme/sales/planner',
      kind: 'agent',
      display_name: 'planner',
      accountable_human_id: 'user:owner',
      affiliation: { organization_id: 'sales', tenant_slug: 'acme' },
      created_at: '2026-11-10T00:00:00.000Z',
    });
    const plan = planAgentIdentityIdMigration();
    expect(plan).toEqual([
      expect.objectContaining({
        legacy_nhi_id: 'kyberion://agent/sales/planner',
        status: 'skipped',
        reason: 'target_exists',
      }),
    ]);
    asController(() => applyAgentIdentityIdMigration());
    expect(listAgentIdentities()).toHaveLength(2);
  });

  it('migration writes are governed', () => {
    // Explicit non-writer context: CI exports MISSION_ROLE=mission_controller,
    // so the ambient role would be allowed.
    expect(() => withExecutionContext('worker', () => applyAgentIdentityIdMigration())).toThrow(
      /requires an agent-runtime-managing/
    );
  });
});
