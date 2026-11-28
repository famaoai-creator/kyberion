import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';
import { writeTenantProfile } from '@agent/core/organization/tenant-registry';
import { parseArgs, run } from './onboarding_context.js';

const fixtureRoot = pathResolver.sharedTmp('internal-organization-onboarding-test');
afterEach(() => safeRmSync(fixtureRoot, { recursive: true, force: true }));

describe('onboarding_context CLI', () => {
  it('routes help output through the injected printer', () => {
    const output: unknown[] = [];

    run(['help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('Onboarding context binding');
  });

  it('defaults binding writes to dry-run and parses first-work acceptance', () => {
    const parsed = parseArgs([
      'first-work',
      '--customer-slug',
      'acme-ai',
      '--intent',
      'Build a new customer portal',
      '--apply',
      '--accept',
      '--bootstrap-project',
    ]);
    expect(parsed.command).toBe('first-work');
    expect(parsed.apply).toBe(true);
    expect(parsed.accept).toBe(true);
    expect(parsed.bootstrapProject).toBe(true);
  });

  it('parses an explicit service context for service-shaped first work', () => {
    const parsed = parseArgs([
      'first-work',
      '--customer-slug',
      'acme-ai',
      '--intent',
      'Operate the customer service',
      '--service-id',
      'customer-operations',
    ]);
    expect(parsed.serviceId).toBe('customer-operations');
  });

  it('keeps bind in dry-run unless apply is explicit', () => {
    const parsed = parseArgs(['bind', '--customer-slug', 'acme-ai', '--tenant-slug', 'acme-prod']);
    expect(parsed.command).toBe('bind');
    expect(parsed.apply).toBe(false);
  });

  it('resolves an explicit root directory for hermetic execution', () => {
    const parsed = parseArgs(['show', '--root-dir', './fixture-root', '--json']);
    expect(parsed.rootDir).toBe(path.resolve('./fixture-root'));
  });

  it('plans an internal organization without a customer stance or a write', () => {
    const args = [
      'organization',
      '--tenant-slug',
      'internal-team',
      '--organization-id',
      'ops',
      '--root-dir',
      fixtureRoot,
      '--json',
    ];
    writeTenantProfile(
      {
        tenant_slug: 'internal-team',
        tenant_id: 'internal-team',
        display_name: 'Internal Team',
        status: 'active',
        assigned_role: 'owner',
      },
      { rootDir: fixtureRoot }
    );
    const result: unknown[] = [];
    run(args, (output) => result.push(output));
    expect(JSON.parse(String(result[0]))).toMatchObject({
      tenant_slug: 'internal-team',
      organization_id: 'ops',
      organization_status: 'missing',
      next_action: { kind: 'preview_organization_init' },
    });
    expect(safeExistsSync(path.join(fixtureRoot, 'active/organizations'))).toBe(false);
    expect(safeExistsSync(path.join(fixtureRoot, 'knowledge/personal/stances'))).toBe(false);
    expect(() => run([...args, '--apply'])).toThrow(/read-only/);
    expect(() =>
      withExecutionContext('sovereign_concierge', () => run(args), undefined, 'other-tenant')
    ).toThrow(/does not match the current tenant scope/);
  });
});
