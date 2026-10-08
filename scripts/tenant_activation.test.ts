import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { resolveIdentityContext } from '@agent/core/authority';
import { activationScope, main } from './tenant_activation.js';

const observed = vi.hoisted(() => ({ tenantSlugs: [] as (string | undefined)[] }));

vi.mock('@agent/core/organization/tenant-activation', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent/core/organization/tenant-activation')>();
  return {
    ...actual,
    resolveTenantActivation: () => {
      observed.tenantSlugs.push(resolveIdentityContext().tenantSlug);
      return { mode: 'dry_run' };
    },
  };
});

describe('tenant activation output boundary', () => {
  it('routes help output through the injected printer', () => {
    const output: unknown[] = [];

    main(['help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('Tenant activation gate');
  });

  it('does not keep a direct console output fallback', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/tenant_activation.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});

describe('tenant activation facade tenant binding', () => {
  let savedTenant: string | undefined;
  beforeEach(() => {
    savedTenant = process.env.KYBERION_TENANT;
    delete process.env.KYBERION_TENANT;
    observed.tenantSlugs.length = 0;
  });
  afterEach(() => {
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
  });

  it('binds the tenant from --tenant-slug so plan needs no KYBERION_TENANT', () => {
    const output: unknown[] = [];
    main(
      [
        'plan',
        '--customer-slug',
        'acme',
        '--tenant-slug',
        'acme-prod',
        '--organization-id',
        'acme',
      ],
      (value) => output.push(value)
    );
    expect(observed.tenantSlugs).toEqual(['acme-prod']);
    expect(output).toHaveLength(1);
  });

  it('rejects a tenant slug that is not a tenant (reserved scope name)', () => {
    expect(activationScope(['--tenant-slug', 'acme-prod', '--organization-id', 'acme'])).toEqual({
      tenantSlug: 'acme-prod',
      organizationId: 'acme',
    });
    expect(() => activationScope(['--tenant-slug', 'confidential'])).toThrow(
      /not a valid tenant slug/
    );
  });
});

describe('tenant activation plan shows LLM availability per data tier', () => {
  it('prints which providers each tier can use, and how to enable confidential', () => {
    const output: unknown[] = [];
    main(
      [
        'plan',
        '--customer-slug',
        'acme',
        '--tenant-slug',
        'acme-prod',
        '--organization-id',
        'acme',
      ],
      (value) => output.push(value)
    );
    const plan = JSON.parse(String(output[0]));
    expect(plan.mode).toBe('dry_run');
    const tiers = plan.llm_availability.tiers as Array<{
      tier: string;
      usable: Array<{ provider: string }>;
      note: string;
    }>;
    expect(tiers.map((entry) => entry.tier)).toEqual(['public', 'confidential', 'personal']);
    expect(tiers[0]!.usable.map((entry) => entry.provider)).toContain('claude');
    // Nothing attested for this tenant: confidential has no external provider.
    expect(tiers[1]!.usable.map((entry) => entry.provider)).not.toContain('claude');
    expect(tiers[1]!.note).toContain('pnpm onboarding llm attest --tenant acme-prod');
  });
});
