/**
 * DA-01: tests for the tenant registry consistency checker.
 *
 * Hermetic: every case seeds a fixture tree under active/shared/tmp (the
 * governed temp location) and drives the checker through its `rootDir`/`env`
 * seam — the real knowledge/, customer/, and exceptions file are only touched
 * by the final "current repository state" acceptance test, which is the same
 * assertion CI's `check:tenant-registry` gate makes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXCEPTIONS_RELATIVE_PATH,
  collectTenantSystems,
  loadTenantRegistryExceptions,
  runCheck,
} from './check_tenant_registry_consistency.js';

const FIXTURE_PARENT = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp');
const EMPTY_ENV = {} as NodeJS.ProcessEnv; // no KYBERION_CUSTOMER → personal tenants dir

describe('check_tenant_registry_consistency (DA-01)', () => {
  let fixtureRoot = '';

  beforeEach(() => {
    fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
    fixtureRoot = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'tenant-consistency-'));
  });

  afterEach(() => {
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = '';
  });

  function seedProfile(slug: string): void {
    const dir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${slug}.json`),
      JSON.stringify({
        tenant_slug: slug,
        display_name: `Tenant ${slug}`,
        status: 'active',
        assigned_role: 'owner',
      })
    );
  }

  function seedConfidentialIndex(slugs: string[]): void {
    const dir = path.join(fixtureRoot, 'knowledge', 'confidential', 'tenants');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({
        tenants: slugs.map((id) => ({
          id,
          override_path: `knowledge/confidential/${id}/design/tenant-override.json`,
        })),
      })
    );
  }

  function seedCustomerDir(slug: string): void {
    fs.mkdirSync(path.join(fixtureRoot, 'customer', slug), { recursive: true });
  }

  function seedCustomerTenantProfile(customerSlug: string, tenantSlug: string): void {
    const dir = path.join(fixtureRoot, 'customer', customerSlug, 'tenants');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${tenantSlug}.json`),
      JSON.stringify({
        tenant_slug: tenantSlug,
        display_name: `Tenant ${tenantSlug}`,
        status: 'active',
        assigned_role: 'owner',
      })
    );
  }

  function seedExceptions(exceptions: Array<{ slug: string; reason: string }>): void {
    const file = path.join(fixtureRoot, EXCEPTIONS_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ _meta: 'test fixture', exceptions }));
  }

  const options = () => ({ rootDir: fixtureRoot, env: EMPTY_ENV });

  it('is green when every slug in every system has a tenant profile', () => {
    seedProfile('acme-corp');
    seedProfile('beta-co');
    seedConfidentialIndex(['acme-corp']);
    seedCustomerDir('acme-corp');
    seedCustomerDir('beta-co');
    const { exitCode, output } = runCheck(options());
    expect(output).toContain('[check:tenant-registry] OK');
    expect(exitCode).toBe(0);
  });

  it('treats a profile-only slug as consistent (the profile is the spine)', () => {
    seedProfile('acme-corp');
    const { exitCode, output } = runCheck(options());
    expect(output).toContain('[check:tenant-registry] OK');
    expect(exitCode).toBe(0);
  });

  it('ignores top-level customer stance directories without tenant facets', () => {
    seedProfile('acme-corp');
    seedCustomerDir('acme-corp');
    seedCustomerDir('ghost-co');
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(0);
    expect(output).not.toContain('ghost-co');
    expect(output).toContain('[check:tenant-registry] OK');
  });

  it('does not follow a symlinked customer stance directory', () => {
    seedProfile('acme-corp');
    const customerBase = path.join(fixtureRoot, 'customer');
    const outside = path.join(fixtureRoot, 'outside-customer');
    fs.mkdirSync(path.join(outside, 'tenants'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'tenants', 'ghost-co.json'), '{}');
    fs.mkdirSync(customerBase, { recursive: true });
    fs.symlinkSync(outside, path.join(customerBase, 'linked-customer'), 'dir');

    const systems = collectTenantSystems(options());

    expect(systems.customerTenantProfiles).toEqual([]);
  });

  it('flags a customer tenant profile facet with no tenant profile as drift', () => {
    seedProfile('acme-corp');
    seedCustomerTenantProfile('acme-corp', 'ghost-co');
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "'ghost-co' is known to customer tenant profile but has no tenant profile"
    );
  });

  it('flags a confidential-index entry with no tenant profile as drift', () => {
    seedProfile('acme-corp');
    seedConfidentialIndex(['acme-corp', 'ghost-co']);
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain("'ghost-co' is known to confidential index but has no tenant profile");
  });

  it('fails closed when the confidential index violates its governed schema', () => {
    seedProfile('acme-corp');
    const indexPath = path.join(fixtureRoot, 'knowledge', 'confidential', 'tenants', 'index.json');
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        tenants: [
          {
            id: 'acme-corp',
            override_path: 'knowledge/confidential/acme-corp/design/tenant-override.json',
            unexpected: true,
          },
        ],
      })
    );

    expect(() => collectTenantSystems(options())).toThrow(
      'Invalid catalog tenant-design-override-index'
    );
  });

  it('flags an invalid slug (e.g. _template) without an exception as drift', () => {
    seedCustomerTenantProfile('acme-corp', '_template');
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain("'_template' is not a valid tenant slug");
  });

  it('accepts documented exceptions for intentional asymmetries', () => {
    seedProfile('acme-corp');
    seedCustomerTenantProfile('acme-corp', 'ghost-co');
    seedCustomerTenantProfile('acme-corp', '_template');
    seedExceptions([
      { slug: 'ghost-co', reason: 'demo fixture — not an operating tenant' },
      { slug: '_template', reason: 'customer scaffold template' },
    ]);
    const { exitCode, output } = runCheck(options());
    expect(output).toContain('[check:tenant-registry] OK');
    expect(output).toContain('exception: demo fixture — not an operating tenant');
    expect(exitCode).toBe(0);
  });

  it('rejects schema-invalid exceptions without a reason', () => {
    seedCustomerTenantProfile('acme-corp', 'ghost-co');
    seedExceptions([{ slug: 'ghost-co', reason: '' }]);
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain('Invalid catalog tenant-registry-exceptions');
  });

  it('rejects duplicate exception entries', () => {
    seedCustomerTenantProfile('acme-corp', 'ghost-co');
    seedExceptions([
      { slug: 'ghost-co', reason: 'first' },
      { slug: 'ghost-co', reason: 'second' },
    ]);
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain("duplicate entry for 'ghost-co'");
  });

  it('warns (never fails) on exceptions matching no slug in the checkout', () => {
    seedProfile('acme-corp');
    seedExceptions([{ slug: 'gone-co', reason: 'offboarded 2026-07' }]);
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(0);
    expect(output).toContain("warning: exception for 'gone-co' matches no slug");
  });

  it('flags a schema-invalid profile as a resolution failure', () => {
    const dir = path.join(fixtureRoot, 'knowledge', 'personal', 'tenants');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'broken-co.json'),
      JSON.stringify({ tenant_slug: 'broken-co', status: 'active' })
    );
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain("profile for 'broken-co' failed to resolve");
  });

  it('collects codepoint-sorted slug sets from all systems', () => {
    seedProfile('beta-co');
    seedProfile('acme-corp');
    seedConfidentialIndex(['zeta-co', 'acme-corp']);
    seedCustomerTenantProfile('beta-co', 'beta-co');
    seedCustomerTenantProfile('acme-corp', 'acme-corp');
    const systems = collectTenantSystems(options());
    expect(systems.profiles).toEqual(['acme-corp', 'beta-co']);
    expect(systems.confidentialIndex).toEqual(['acme-corp', 'zeta-co']);
    expect(systems.customerTenantProfiles).toEqual(['acme-corp', 'beta-co']);
    expect(systems.notes.join('\n')).toContain('project registry');
  });

  it('loads exceptions and reports structural problems', () => {
    seedExceptions([{ slug: 'ok-co', reason: 'documented' }]);
    const { exceptions, problems } = loadTenantRegistryExceptions(options());
    expect(exceptions).toEqual([{ slug: 'ok-co', reason: 'documented' }]);
    expect(problems).toEqual([]);
  });

  // Acceptance (DA-01 #1): zero drift in the current repository state — the
  // same assertion CI's check:tenant-registry gate makes. Retry because
  // parallel suites legitimately churn knowledge/ mid-run.
  it('passes on the current repository state', { retry: 2 }, () => {
    // Reading the real knowledge/personal/tenants dir requires an authorized
    // persona/role (Sovereign Sanctuary); the CLI entrypoint gets this from
    // its script-name-derived authority — in-process we set the same env the
    // sibling tenant-registry suite uses.
    const savedPersona = process.env.KYBERION_PERSONA;
    const savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    try {
      const { exitCode, output } = runCheck();
      expect(output).toContain('[check:tenant-registry] OK');
      expect(exitCode).toBe(0);
    } finally {
      if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
      else process.env.KYBERION_PERSONA = savedPersona;
      if (savedRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = savedRole;
    }
  });
});
