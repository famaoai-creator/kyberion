import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/authority';
import { auditChain } from '@agent/core/governance/audit-chain';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { main } from './tenant.js';

describe('tenant CLI output boundary', () => {
  it('keeps tenant governance output free of direct console output', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/tenant.ts'), { encoding: 'utf8' })
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('process.stdout');
    expect(source).not.toContain('process.stderr');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });

  it('routes help output through the supplied printer', () => {
    const output: unknown[] = [];

    main(['help'], (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(String(output[0])).toContain('Usage: pnpm tenant');
  });
});

describe('tenant attest-provider requires --apply --accept', () => {
  const rootDir = pathResolver.sharedTmp(`tenant-attest-cli-${process.pid}`);
  let record: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
    withExecutionContext('sovereign_concierge', () => {
      safeMkdir(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
      safeWriteFile(
        path.join(rootDir, 'knowledge', 'personal', 'tenants', 'acme.json'),
        JSON.stringify({
          tenant_slug: 'acme',
          display_name: 'Acme',
          status: 'active',
          assigned_role: 'owner',
        })
      );
    });
    record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    record.mockRestore();
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  const attestation = () =>
    withExecutionContext('sovereign_concierge', () => readTenantProfile('acme', { rootDir }))
      ?.provider_attestations?.codex;
  const args = ['attest-provider', 'acme', '--provider', 'codex', '--training-use', 'used'];

  it('does not write with --apply alone', () => {
    expect(() => main([...args, '--apply'], () => undefined, { rootDir })).toThrow(
      /requires --accept/
    );
    expect(attestation()).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('writes and audits with --apply --accept', () => {
    main([...args, '--apply', '--accept'], () => undefined, { rootDir });
    expect(attestation()).toMatchObject({ training_use: 'used' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.attest_provider', tenantSlug: 'acme' })
    );
  });

  it('does not write training_use none without an approved request', () => {
    expect(() =>
      main(
        [
          'attest-provider',
          'acme',
          '--provider',
          'codex',
          '--training-use',
          'none',
          '--plan',
          'Enterprise',
          '--basis',
          'https://example.com/terms',
          '--attested-by',
          'human:owner',
          '--apply',
          '--accept',
        ],
        () => undefined,
        { rootDir }
      )
    ).toThrow(/needs a human approval/);
    expect(attestation()).toBeUndefined();
  });
});
