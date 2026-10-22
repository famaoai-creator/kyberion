import { afterEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  evaluateBriefAgainstMandates,
  evaluateMissionStartMandate,
  loadMandateCatalog,
  TENANT_MANDATE_OVERLAY_FILE,
} from './mandate-shadow.js';

const TEST_ROOT = 'active/shared/tmp/mandate-tenant-overlay-tests';
const now = new Date('2026-10-20T00:00:00Z');

function seedTenant(slug: string): void {
  const dir = `${TEST_ROOT}/knowledge/personal/tenants`;
  safeMkdir(dir, { recursive: true });
  safeWriteFile(
    `${dir}/${slug}.json`,
    JSON.stringify({
      tenant_slug: slug,
      display_name: `Tenant ${slug}`,
      status: 'active',
      assigned_role: 'owner',
    })
  );
}

function writeOverlay(slug: string, value: unknown): void {
  const dir = `${TEST_ROOT}/knowledge/confidential/${slug}/governance`;
  safeMkdir(dir, { recursive: true });
  safeWriteFile(
    `${dir}/${TENANT_MANDATE_OVERLAY_FILE}`,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

const mandate = (id: string, tenant: string | undefined) => ({
  id,
  title: 'Weekly digest',
  work_type_patterns: ['weekly digest'],
  allowed_path_globs: ['docs/**'],
  max_risk_level: 2,
  expires_at: '2027-01-01T00:00:00Z',
  ...(tenant
    ? {
        authority: {
          tenant_slug: tenant,
          status: 'active',
          max_cost: 100,
          currency: 'JPY',
          allowed_external_effects: [],
        },
      }
    : {}),
});

const facts = {
  work_type: 'weekly digest',
  paths: ['docs/digest.md'],
  estimated_cost: 10,
  currency: 'JPY',
  external_effects: [],
  risk_level: 1,
};

const load = () => loadMandateCatalog({ rootDir: TEST_ROOT });
const ids = () => load().mandates.map((entry) => entry.id);
const admit = (tenant: string, mandateId: string) =>
  evaluateMissionStartMandate(
    { tenant_slug: tenant, mandate_id: mandateId, facts },
    { catalog: load(), now }
  ).covered;

afterEach(() => {
  if (safeExistsSync(TEST_ROOT)) safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('tenant standing mandate overlay', () => {
  it('admits a mission for its own tenant only', () => {
    seedTenant('tenant-acme');
    seedTenant('tenant-globex');
    writeOverlay('tenant-acme', {
      version: '1',
      mandates: [mandate('acme-digest', 'tenant-acme')],
    });
    expect(admit('tenant-acme', 'acme-digest')).toBe(true);
    expect(admit('tenant-globex', 'acme-digest')).toBe(false);
    // Product mandates are unchanged, and shadow briefs never see tenant mandates.
    expect(ids()).toEqual(expect.arrayContaining(['test-strengthening', 'acme-digest']));
    expect(
      evaluateBriefAgainstMandates(
        { title: 'weekly digest', scope: { in: ['docs/digest.md'] }, gate: { riskLevel: 1 } },
        { now }
      ).covered
    ).toBe(false);
  });

  it('drops mandates bound to another tenant or without authority', () => {
    seedTenant('tenant-acme');
    seedTenant('tenant-globex');
    writeOverlay('tenant-acme', {
      version: '1',
      mandates: [mandate('spoof', 'tenant-globex'), mandate('bare', undefined)],
    });
    expect(ids()).not.toContain('spoof');
    expect(ids()).not.toContain('bare');
    expect(admit('tenant-globex', 'spoof')).toBe(false);
  });

  it('drops ids that collide with a product mandate or another tenant', () => {
    seedTenant('tenant-acme');
    seedTenant('tenant-globex');
    writeOverlay('tenant-acme', {
      version: '1',
      mandates: [mandate('docs-update', 'tenant-acme'), mandate('shared', 'tenant-acme')],
    });
    writeOverlay('tenant-globex', { version: '1', mandates: [mandate('shared', 'tenant-globex')] });
    const catalog = load();
    const docs = catalog.mandates.filter((entry) => entry.id === 'docs-update');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.authority).toBeUndefined();
    expect(catalog.mandates.some((entry) => entry.id === 'shared')).toBe(false);
    expect(admit('tenant-acme', 'docs-update')).toBe(false);
  });

  it('isolates an invalid overlay to its tenant', () => {
    seedTenant('tenant-acme');
    seedTenant('tenant-globex');
    writeOverlay('tenant-acme', {
      version: '1',
      external_effect_patterns: [],
      mandates: [mandate('acme-digest', 'tenant-acme')],
    });
    writeOverlay('tenant-globex', {
      version: '1',
      mandates: [mandate('globex-digest', 'tenant-globex')],
    });
    expect(ids()).not.toContain('acme-digest');
    expect(admit('tenant-globex', 'globex-digest')).toBe(true);
    writeOverlay('tenant-acme', '{ broken');
    expect(admit('tenant-globex', 'globex-digest')).toBe(true);
  });
});
