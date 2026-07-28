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
import { pathResolver } from '@agent/core';
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

  function seedExceptions(exceptions: Array<{ slug: string; reason: string }>): void {
    const file = path.join(fixtureRoot, EXCEPTIONS_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ exceptions }));
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

  it('flags a customer/ directory with no tenant profile as drift', () => {
    seedProfile('acme-corp');
    seedCustomerDir('acme-corp');
    seedCustomerDir('ghost-co');
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "'ghost-co' is known to customer/ directory but has no tenant profile"
    );
    expect(output).toContain('DRIFT');
  });

  it('flags a confidential-index entry with no tenant profile as drift', () => {
    seedProfile('acme-corp');
    seedConfidentialIndex(['acme-corp', 'ghost-co']);
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain("'ghost-co' is known to confidential index but has no tenant profile");
  });

  it('flags an invalid slug (e.g. _template) without an exception as drift', () => {
    seedCustomerDir('_template');
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain("'_template' is not a valid tenant slug");
  });

  it('accepts documented exceptions for intentional asymmetries', () => {
    seedProfile('acme-corp');
    seedCustomerDir('ghost-co');
    seedCustomerDir('_template');
    seedExceptions([
      { slug: 'ghost-co', reason: 'demo fixture — not an operating tenant' },
      { slug: '_template', reason: 'customer scaffold template' },
    ]);
    const { exitCode, output } = runCheck(options());
    expect(output).toContain('[check:tenant-registry] OK');
    expect(output).toContain('exception: demo fixture — not an operating tenant');
    expect(exitCode).toBe(0);
  });

  it('rejects exceptions without a reason', () => {
    seedCustomerDir('ghost-co');
    seedExceptions([{ slug: 'ghost-co', reason: '' }]);
    const { exitCode, output } = runCheck(options());
    expect(exitCode).toBe(1);
    expect(output).toContain("'ghost-co' has no reason");
  });

  it('rejects duplicate exception entries', () => {
    seedCustomerDir('ghost-co');
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
    seedCustomerDir('beta-co');
    seedCustomerDir('acme-corp');
    const systems = collectTenantSystems(options());
    expect(systems.profiles).toEqual(['acme-corp', 'beta-co']);
    expect(systems.confidentialIndex).toEqual(['acme-corp', 'zeta-co']);
    expect(systems.customerDirs).toEqual(['acme-corp', 'beta-co']);
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
