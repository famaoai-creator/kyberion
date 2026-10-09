import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pathResolver,
  safeChmodSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeStat,
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
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  decideApprovalRequest,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import {
  captureAttestationInvoker,
  PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
} from '@agent/core/organization/tenant-governance';
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

/**
 * Split a printed command the way a POSIX shell would for the quoting the CLI
 * emits (bare words and single quotes). An unquoted metacharacter fails the
 * test: it would be interpreted by the operator's shell, not passed through.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated quote in: ${command}`);
      current += command.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (ch === '\\') {
      current += command[++i] ?? '';
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else if (/[;&|<>$`"(){}*?#~!]/.test(ch)) {
      throw new Error(`unquoted shell metacharacter '${ch}' in: ${command}`);
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
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

  it('rewrites only the KYBERION_REASONING_BACKEND line, keeps a 0600 mode, and says what changed', () => {
    const envLocal = path.join(ROOT, 'env.local');
    safeWriteFile(envLocal, 'SECRET_TOKEN=abc\nKYBERION_REASONING_BACKEND=codex-cli\nOTHER=1\n', {
      mode: 0o600,
    });
    safeChmodSync(envLocal, 0o600);
    const output = run(['select', '--backend', 'anthropic', '--apply']).join('\n');
    expect(output).toContain(
      `Updated ${envLocal}: KYBERION_REASONING_BACKEND codex-cli -> anthropic (other lines unchanged)`
    );
    expect(String(safeReadFile(envLocal, { encoding: 'utf8' }))).toBe(
      'SECRET_TOKEN=abc\nKYBERION_REASONING_BACKEND=anthropic\nOTHER=1\n'
    );
    expect(safeStat(envLocal).mode & 0o777).toBe(0o600);
  });

  it('attributes the selection audit to the invoking identity, not the elevation', () => {
    const invoker = captureAttestationInvoker().actor;
    run(['select', '--backend', 'anthropic', '--apply']);
    const entry = record.mock.calls.find(
      ([call]) => (call as { action?: string }).action === 'onboarding.llm_select'
    )?.[0] as { agentId: string };
    expect(entry.agentId).toBe(invoker);
    expect(entry.agentId).not.toMatch(/sovereign/);
  });

  describe('attest', () => {
    const requestIds: string[] = [];
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
    const egress = (tenant: string) =>
      checkProviderEgress({
        provider: 'claude',
        dataTier: 'confidential',
        tenant_slug: tenant,
        tenant_registry_root_dir: path.join(ROOT, 'repo'),
      }).allowed;

    function humanApproves(id: string): void {
      const pending = loadApprovalRequest(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id)!;
      decideApprovalRequest('mission_controller', {
        channel: pending.channel,
        storageChannel: pending.storageChannel,
        requestId: id,
        decision: 'approved',
        decidedBy: 'human-owner',
        decidedByRole: 'sovereign',
        authMethod: 'manual',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: pending.accountability?.payloadHash,
        effectBinding: pending.accountability?.effectBinding,
      });
    }

    beforeEach(() => {
      writeTenant('acme');
      writeTenant('other');
    });

    afterEach(() => {
      for (const id of requestIds.splice(0)) {
        safeRmSync(approvalRequestLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id), {
          force: true,
        });
      }
      safeRmSync(approvalEventLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL), { force: true });
    });

    it('training_use none: request approval, a human approves, then apply — audited with the approver', () => {
      // Default deny, and the dry-run shows the consequence and the approval step.
      expect(egress('acme')).toBe(false);
      const preview = run(args).join('\n');
      expect(preview).toContain('[dry-run] would attest tenant=acme provider=claude');
      expect(preview).toMatch(/confidential: local-only \(laya-mlx\)/);
      expect(preview).toContain('--request-approval');
      expect(() => run([...args, '--apply'])).toThrow(/requires --accept/);
      // --apply --accept alone is not enough for none.
      expect(() => run([...args, '--apply', '--accept'])).toThrow(/needs a human approval/);
      expect(egress('acme')).toBe(false);

      const request = JSON.parse(run([...args, '--request-approval', '--json'])[0]!);
      requestIds.push(request.request_id);
      expect(request.approve_command).toBe(
        `pnpm kyberion approvals --approve ${request.request_id}`
      );
      expect(() =>
        run([...args, '--apply', '--accept', '--approval-request-id', request.request_id])
      ).toThrow(/is pending/);
      expect(record).not.toHaveBeenCalled();

      humanApproves(request.request_id);
      const applied = JSON.parse(
        run([
          ...args,
          '--apply',
          '--accept',
          '--approval-request-id',
          request.request_id,
          '--json',
        ])[0]!
      );
      expect(applied.approval).toEqual({
        request_id: request.request_id,
        approved_by: 'human-owner',
      });
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant.attest_provider',
          tenantSlug: 'acme',
          metadata: expect.objectContaining({ approved_by: 'human-owner' }),
        })
      );
      const confidential = applied.availability.tiers.find(
        (tier: { tier: string }) => tier.tier === 'confidential'
      );
      expect(confidential.usable).toContainEqual({
        provider: 'claude',
        basis: 'tenant-attestation',
      });
      expect(egress('acme')).toBe(true);
      expect(egress('other')).toBe(false);
    });

    it('a request approved for one plan does not apply to another', () => {
      const request = JSON.parse(run([...args, '--request-approval', '--json'])[0]!);
      requestIds.push(request.request_id);
      humanApproves(request.request_id);
      const otherPlan = args.map((value) => (value === 'Claude Team' ? 'Claude Free' : value));
      expect(() =>
        run([...otherPlan, '--apply', '--accept', '--approval-request-id', request.request_id])
      ).toThrow(/different training_use\/plan/);
      expect(egress('acme')).toBe(false);
    });

    it('prints a follow-up apply command that applies as-is when pasted', () => {
      // Values with spaces, an apostrophe and shell metacharacters: eliding or
      // mis-quoting any of them breaks the payload-hash binding.
      const tricky = [
        'attest',
        '--tenant',
        'acme',
        '--provider',
        'claude',
        '--training-use',
        'none',
        '--plan',
        "Claude Team (Acme's workspace)",
        '--basis',
        'https://www.anthropic.com/legal/commercial-terms?a=1&b=$HOME',
        '--attested-by',
        'human:owner',
        '--valid-for-days',
        '90',
      ];
      const lines = run([...tricky, '--request-approval']);
      const text = lines.join('\n');
      expect(text).not.toContain('...');
      const printed = /Then apply with the same values \(POSIX shell: sh\/bash\/zsh\): (.+)$/m.exec(
        text
      )?.[1];
      expect(printed).toBeDefined();
      const requestId = /approval request ([0-9a-f-]{36})/.exec(text)![1]!;
      requestIds.push(requestId);

      const words = shellWords(printed!);
      expect(words.slice(0, 3)).toEqual(['pnpm', 'onboarding', 'llm']);
      const json = JSON.parse(run([...tricky, '--request-approval', '--json'])[0]!);
      expect(json.apply_command).toBe(printed);

      humanApproves(requestId);
      const applied = JSON.parse(run([...words.slice(3), '--json'])[0]!);
      expect(applied.applied).toBe(true);
      expect(applied.attestation).toMatchObject({
        training_use: 'none',
        plan: "Claude Team (Acme's workspace)",
        basis: 'https://www.anthropic.com/legal/commercial-terms?a=1&b=$HOME',
      });
      expect(applied.approval).toEqual({ request_id: requestId, approved_by: 'human-owner' });
      expect(egress('acme')).toBe(true);
    });

    it('rejects a backslash or control character at parse time, before any dry-run output', () => {
      const withValue = (flag: string, value: string) =>
        args.map((entry, index) => (args[index - 1] === flag ? value : entry));
      expect(() => run(withValue('--plan', 'C:\\plan'))).toThrow(
        /--plan must not contain a backslash/
      );
      expect(() =>
        run([...withValue('--attested-by', 'owner\u0007'), '--request-approval'])
      ).toThrow(/--attested-by must not contain control characters/);
    });

    it('records used/unknown with --apply --accept and no approval', () => {
      const used = ['attest', '--tenant', 'acme', '--provider', 'codex', '--training-use', 'used'];
      expect(() => run([...used, '--apply'])).toThrow(/requires --accept/);
      const applied = JSON.parse(run([...used, '--apply', '--accept', '--json'])[0]!);
      expect(applied.attestation.training_use).toBe('used');
      expect(applied.approval).toBeUndefined();
    });

    it('refuses to attest for another tenant from a tenant-bound process', () => {
      const used = ['attest', '--tenant', 'acme', '--provider', 'codex', '--training-use', 'used'];
      expect(() =>
        withExecutionContext(
          'mission_controller',
          () => run([...used, '--apply', '--accept']),
          undefined,
          'other'
        )
      ).toThrow(/cross-tenant attestation refused/);
    });

    it('rejects an unknown provider, a missing training_use statement and missing evidence', () => {
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
  });

  it('show reports the effective tenant and why each tier denies providers', () => {
    writeTenant('acme');
    const output = run(['show', '--tenant', 'acme']).join('\n');
    expect(output).toContain('LLM availability by data tier (tenant acme)');
    expect(output).toContain('pnpm onboarding llm attest --tenant acme');
    expect(output).toMatch(/✘ denied: .*claude.* — e\.g\. /);
    expect(output).toContain('✔ laya-mlx (local-only)');

    const ambient = withExecutionContext(
      'mission_controller',
      () => run(['show', '--json']),
      undefined,
      'acme'
    );
    const report = JSON.parse(ambient[0]!).availability;
    expect(report).toMatchObject({ tenant_slug: 'acme', tenant_source: 'ambient' });
    expect(() =>
      withExecutionContext(
        'mission_controller',
        () => run(['show', '--tenant', 'other']),
        undefined,
        'acme'
      )
    ).toThrow(/conflicts with the active tenant scope 'acme'/);
  });
});
