import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_ASK_EVENT_TYPE,
  ingestAskIntake,
  ingestLocalEvent,
  loadEventIntakePolicy,
  processInboundEventRequest,
  readDotInboundEvents,
  TENANT_EVENT_INTAKE_OVERLAY_FILE,
} from './dot-event-intake.js';

const TEST_ROOT = 'active/shared/tmp/dot-event-intake-overlay-tests';
const SECRET = 'test-secret-value-0123456789';

const source = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  signature_header: 'x-kyberion-signature',
  prefix: 'sha256=',
  secret_key: 'EVENT_INTAKE_OPS_SECRET',
  event_type_header: 'x-kyberion-event',
  delivery_id_header: 'x-kyberion-delivery',
  max_body_bytes: 4096,
  ...overrides,
});

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
    `${dir}/${TENANT_EVENT_INTAKE_OVERLAY_FILE}`,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

const load = () =>
  loadEventIntakePolicy({ tenantOverlays: true, rootDir: TEST_ROOT, hostOptIn: '' });

afterEach(() => {
  if (safeExistsSync(TEST_ROOT)) safeRmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('tenant event intake overlay', () => {
  it('binds overlay sources to their tenant and keeps them out of the default policy', () => {
    seedTenant('tenant-acme');
    writeOverlay('tenant-acme', { version: '1', sources: { 'acme-ops': source() } });
    const policy = load();
    expect(policy.sources['acme-ops']).toMatchObject({
      tenant_slug: 'tenant-acme',
      local_only: true,
    });
    expect(policy.sources.github.enabled).toBe(false);
    expect(
      Object.keys(loadEventIntakePolicy({ hostOptIn: '', rootDir: TEST_ROOT }).sources)
    ).not.toContain('acme-ops');
  });

  it('accepts an overlay source for local ingest into the tenant ledger', () => {
    seedTenant('tenant-acme');
    writeOverlay('tenant-acme', { version: '1', sources: { 'acme-ops': source() } });
    const result = ingestLocalEvent({ source: 'acme-ops', body: { a: 1 }, rootDir: TEST_ROOT });
    expect(result.status).toBe('accepted');
    expect(result.event.tenant_slug).toBe('tenant-acme');
    expect(readDotInboundEvents('tenant-acme', { rootDir: TEST_ROOT })).toHaveLength(1);
  });

  it('refuses an overlay source over the HTTP webhook even when enabled and signed', () => {
    seedTenant('tenant-acme');
    writeOverlay('tenant-acme', { version: '1', sources: { 'acme-ops': source() } });
    const body = '{"a":1}';
    const response = processInboundEventRequest({
      source: 'acme-ops',
      headers: {
        'x-kyberion-signature': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
        'x-kyberion-event': 'ping',
        'x-kyberion-delivery': 'd-1',
      },
      body,
      policy: load(),
      getSecret: () => SECRET,
      rootDir: TEST_ROOT,
    });
    expect(response).toEqual({ status: 401, code: 'disabled_source' });
    expect(readDotInboundEvents('tenant-acme', { rootDir: TEST_ROOT })).toHaveLength(0);
  });

  it('routes a scoped ask to the tenant dot through its overlay source', () => {
    seedTenant('tenant-acme');
    writeOverlay('tenant-acme', { version: '1', sources: { 'acme-ops': source() } });
    const dot = {
      kind: 'dot-charter',
      dot_id: 'acme-front',
      status: 'active',
      scope: { tier: 'confidential', tenant_slug: 'tenant-acme', organization_id: 'org-a' },
      attention: {
        triggers: [{ kind: 'event', sources: ['acme-ops'], types: [DOT_ASK_EVENT_TYPE] }],
      },
    } as unknown as DotCharter;
    const ask = (tenant: string) =>
      ingestAskIntake({
        text: 'Summarise the week.',
        scope: { tier: 'confidential', tenant_slug: tenant, organization_id: 'org-a' },
        charters: [dot, { ...dot, scope: { ...dot.scope, tenant_slug: 'tenant-globex' } }],
        rootDir: TEST_ROOT,
      });
    expect(ask('tenant-acme')).toMatchObject({
      status: 'accepted',
      dot_id: 'acme-front',
      source: 'acme-ops',
    });
    // Another tenant's dot naming the same source never gets it.
    expect(ask('tenant-globex')).toEqual({ status: 'no_intake' });
  });

  it('drops a source that declares another tenant or reuses a product or shared name', () => {
    seedTenant('tenant-acme');
    seedTenant('tenant-globex');
    writeOverlay('tenant-acme', {
      version: '1',
      sources: {
        spoof: source({ tenant_slug: 'tenant-globex' }),
        github: source(),
        shared: source(),
        'acme-own': source({ tenant_slug: 'tenant-acme' }),
      },
    });
    writeOverlay('tenant-globex', { version: '1', sources: { shared: source() } });
    const policy = load();
    expect(policy.sources.spoof).toBeUndefined();
    expect(policy.sources.github.local_only).toBeUndefined();
    expect(policy.sources.github.tenant_slug).toBeUndefined();
    expect(policy.sources.shared).toBeUndefined();
    expect(policy.sources['acme-own']).toMatchObject({ tenant_slug: 'tenant-acme' });
  });

  it('isolates an invalid overlay to its tenant', () => {
    seedTenant('tenant-acme');
    seedTenant('tenant-globex');
    writeOverlay('tenant-acme', { version: '1', sources: { broken: { enabled: true } } });
    writeOverlay('tenant-globex', { version: '1', sources: { 'globex-ops': source() } });
    const policy = load();
    expect(policy.sources.broken).toBeUndefined();
    expect(policy.sources['globex-ops']).toMatchObject({ tenant_slug: 'tenant-globex' });
    writeOverlay('tenant-acme', '{ not json');
    expect(load().sources['globex-ops']).toBeDefined();
  });

  it('ignores overlays of unregistered tenants', () => {
    writeOverlay('tenant-ghost', { version: '1', sources: { 'ghost-ops': source() } });
    expect(load().sources['ghost-ops']).toBeUndefined();
  });
});
