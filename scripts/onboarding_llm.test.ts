import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { withExecutionContext } from '@agent/core/authority';

const fixture = vi.hoisted(() => ({ profileRoot: '' }));

vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: () => fixture.profileRoot,
}));
// Provider discovery probes installed CLIs; selection here only needs
// env-configured runtimes, so keep the test hermetic.
vi.mock('@agent/core/provider/provider-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/provider/provider-discovery')>()),
  discoverProviders: () => [],
}));
vi.mock('@agent/core/ops-alert', () => ({ sendOpsAlert: vi.fn() }));

import { auditChain } from '@agent/core/governance/audit-chain';
import { checkProviderEgress } from '@agent/core/provider/provider-egress-gate';
import { resolveReasoningRoute } from '@agent/core/reasoning/reasoning-route-resolver';
import { main } from './onboarding_llm.js';
import { ONBOARD_CLI } from './onboarding_mode.js';

const ROOT = pathResolver.sharedTmp(`onboarding-llm-test-${process.pid}`);

function run(argv: string[], options: Parameters<typeof main>[2] = {}): string[] {
  const output: string[] = [];
  main(argv, (value) => output.push(String(value)), {
    envLocalPath: path.join(ROOT, 'env.local'),
    tenantRegistryRootDir: path.join(ROOT, 'repo'),
    ...options,
  });
  return output;
}

function selectionFile(): string {
  return path.join(fixture.profileRoot, 'onboarding', 'llm-selection.json');
}

function writeTenant(slug: string): void {
  const dir = path.join(ROOT, 'repo', 'knowledge', 'personal', 'tenants');
  withExecutionContext('sovereign_concierge', () => {
    safeMkdir(dir, { recursive: true });
    safeWriteFile(
      path.join(dir, `${slug}.json`),
      JSON.stringify({
        tenant_slug: slug,
        display_name: slug,
        status: 'active',
        assigned_role: 'owner',
      })
    );
  });
}

describe('pnpm onboarding llm', () => {
  let record: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fixture.profileRoot = path.join(ROOT, 'profile');
    safeRmSync(ROOT, { recursive: true, force: true });
    safeMkdir(ROOT, { recursive: true });
    vi.stubEnv('KYBERION_REASONING_BACKEND', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-onboarding-llm');
    record = vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    record.mockRestore();
    vi.unstubAllEnvs();
    safeRmSync(ROOT, { recursive: true, force: true });
  });

  it('is a subcommand of the onboarding facade', () => {
    expect(ONBOARD_CLI.subcommands).toContain('llm');
  });

  it('rejects a backend outside reasoning-backend-policy allowed_modes', () => {
    expect(() => run(['select', '--backend', 'bogus-backend', '--apply'])).toThrow(
      /Invalid --backend 'bogus-backend'.*claude-cli/
    );
    expect(safeExistsSync(selectionFile())).toBe(false);
  });

  it('rejects a model that is not in the governed model registry', () => {
    expect(() =>
      run(['select', '--backend', 'anthropic', '--model', 'not-a-real-model', '--apply'])
    ).toThrow(/not registered/);
    expect(safeExistsSync(selectionFile())).toBe(false);
  });

  it('is dry-run without --apply', () => {
    const output = run(['select', '--backend', 'anthropic', '--model', 'claude-sonnet-5']);
    expect(output.join('\n')).toContain('[dry-run] would record backend=anthropic');
    expect(safeExistsSync(selectionFile())).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('persists the backend/model choice, audits it, and the route resolver uses it', () => {
    const output = run([
      'select',
      '--backend',
      'anthropic',
      '--model',
      'claude-sonnet-5',
      '--apply',
    ]);
    expect(output.join('\n')).toContain(
      'Recorded backend=anthropic model=anthropic:claude-sonnet-5'
    );

    const saved = JSON.parse(String(safeReadFile(selectionFile(), { encoding: 'utf8' })));
    expect(saved).toMatchObject({ provider: 'anthropic', model_id: 'anthropic:claude-sonnet-5' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'onboarding.llm_select',
        metadata: expect.objectContaining({
          provider: 'anthropic',
          model_id: 'anthropic:claude-sonnet-5',
        }),
      })
    );

    const route = resolveReasoningRoute({ role: 'default', env: {} });
    expect(route.mode).toBe('anthropic');
    expect(route.model).toBe('anthropic:claude-sonnet-5');
    expect(route.provenance).toContainEqual({
      source: 'operator-selection',
      field: 'llm-selection.json',
    });
  });

  it('updates a conflicting persisted KYBERION_REASONING_BACKEND so the choice takes effect', () => {
    const envLocal = path.join(ROOT, 'env.local');
    safeWriteFile(envLocal, 'KYBERION_REASONING_BACKEND=codex-cli\nOTHER=1\n');
    run(['select', '--backend', 'anthropic', '--apply']);
    const content = String(safeReadFile(envLocal, { encoding: 'utf8' }));
    expect(content).toContain('KYBERION_REASONING_BACKEND=anthropic');
    expect(content).toContain('OTHER=1');
  });

  it('records an attestation only with --apply --accept, audited, for that tenant only', () => {
    writeTenant('acme');
    writeTenant('other');
    const egress = (tenant: string) =>
      checkProviderEgress({
        provider: 'claude',
        dataTier: 'confidential',
        tenant_slug: tenant,
        tenant_registry_root_dir: path.join(ROOT, 'repo'),
      }).allowed;
    const args = [
      'attest',
      '--tenant',
      'acme',
      '--provider',
      'claude',
      '--training-use',
      'none',
      '--plan',
      'Claude Team',
      '--basis',
      'https://www.anthropic.com/legal/commercial-terms',
      '--attested-by',
      'human:owner',
    ];

    // Default deny, and the dry-run shows the operator the consequence.
    expect(egress('acme')).toBe(false);
    const preview = run(args).join('\n');
    expect(preview).toContain('[dry-run] would attest tenant=acme provider=claude');
    expect(preview).toMatch(/confidential: local-only \(laya-mlx\)/);
    expect(() => run([...args, '--apply'])).toThrow(/requires --accept/);
    expect(egress('acme')).toBe(false);
    expect(record).not.toHaveBeenCalled();

    const applied = JSON.parse(run([...args, '--apply', '--accept', '--json'])[0]!);
    expect(applied.attestation).toMatchObject({ training_use: 'none', plan: 'Claude Team' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tenant.attest_provider', tenantSlug: 'acme' })
    );
    const confidential = applied.availability.tiers.find(
      (tier: { tier: string }) => tier.tier === 'confidential'
    );
    expect(confidential.usable).toContainEqual({ provider: 'claude', basis: 'tenant-attestation' });
    expect(egress('acme')).toBe(true);
    expect(egress('other')).toBe(false);
  });

  it('rejects an unknown provider and a missing training_use statement', () => {
    writeTenant('acme');
    expect(() =>
      run(['attest', '--tenant', 'acme', '--provider', 'nope', '--training-use', 'none'])
    ).toThrow(/Unknown --provider 'nope'/);
    expect(() => run(['attest', '--tenant', 'acme', '--provider', 'claude'])).toThrow(
      /explicit --training-use/
    );
    expect(() =>
      run(['attest', '--tenant', 'acme', '--provider', 'claude', '--training-use', 'none'])
    ).toThrow(/requires --plan, --basis, --attested-by/);
  });

  it('show reports per-tier availability for a tenant', () => {
    writeTenant('acme');
    const output = run(['show', '--tenant', 'acme']).join('\n');
    expect(output).toContain('LLM availability by data tier (tenant acme)');
    expect(output).toContain('pnpm onboarding llm attest --tenant acme');
  });
});
