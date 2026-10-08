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
vi.mock('@agent/core/provider/provider-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/provider/provider-discovery')>()),
  discoverProviders: () => [],
}));
vi.mock('@agent/core/ops-alert', () => ({ sendOpsAlert: vi.fn() }));

import { auditChain } from '@agent/core/governance/audit-chain';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  listApprovalRequests,
} from '@agent/core/governance/approval-store';
import { PROVIDER_ATTESTATION_APPROVAL_CHANNEL } from '@agent/core/organization/tenant-governance';
import { readTenantProfile } from '@agent/core/organization/tenant-registry';
import { promptProviderAttestation, promptReasoningModel } from './onboarding_llm_prompts.js';

const ROOT = pathResolver.sharedTmp(`onboarding-llm-prompts-test-${process.pid}`);
const REPO = path.join(ROOT, 'repo');

/** Scripted wizard answers; an exhausted script answers with the prompt's default. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const printed: string[] = [];
  return {
    asked,
    printed,
    deps: {
      ask: async (question: string, defaultValue = '') => {
        asked.push(question);
        const next = answers.shift();
        return next === undefined || next === '' ? defaultValue : next;
      },
      print: (value: unknown) => printed.push(String(value)),
      invoker: { actor: 'wizard-operator' },
      envLocalPath: path.join(ROOT, 'env.local'),
      tenantRegistryRootDir: REPO,
    },
  };
}

function selection(): Record<string, unknown> | null {
  const file = path.join(fixture.profileRoot, 'onboarding', 'llm-selection.json');
  return safeExistsSync(file) ? JSON.parse(String(safeReadFile(file, { encoding: 'utf8' }))) : null;
}

function attestationRequests() {
  return listApprovalRequests({ storageChannels: [PROVIDER_ATTESTATION_APPROVAL_CHANNEL] });
}

describe('onboarding wizard: reasoning model step', () => {
  beforeEach(() => {
    fixture.profileRoot = path.join(ROOT, 'profile');
    safeRmSync(ROOT, { recursive: true, force: true });
    safeMkdir(ROOT, { recursive: true });
    vi.stubEnv('KYBERION_REASONING_BACKEND', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-onboarding-llm');
    vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    safeRmSync(ROOT, { recursive: true, force: true });
  });

  it('defaults to the backend’s default model on Enter', async () => {
    const { deps, printed } = scripted(['']);
    const result = await promptReasoningModel('anthropic', deps);
    expect(result.model_id).toBe('anthropic:claude-opus-5-5');
    expect(selection()).toMatchObject({
      provider: 'anthropic',
      model_id: 'anthropic:claude-opus-5-5',
    });
    expect(printed.join('\n')).toContain('anthropic:claude-opus-5-5 (default)');
  });

  it('re-asks on an unregistered model and accepts a short id', async () => {
    const { deps, printed } = scripted(['gpt-nothing', 'claude-sonnet-5']);
    const result = await promptReasoningModel('anthropic', deps);
    expect(printed.join('\n')).toContain("'gpt-nothing' is not a registered model.");
    expect(result.model_id).toBe('anthropic:claude-sonnet-5');
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'wizard-operator', action: 'onboarding.llm_select' })
    );
  });

  it('skips a backend that is not ready here without writing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { deps } = scripted([]);
    expect(await promptReasoningModel('anthropic', deps)).toEqual({ recorded: false });
    expect(selection()).toBeNull();
  });
});

describe('onboarding wizard: provider attestation step', () => {
  beforeEach(() => {
    fixture.profileRoot = path.join(ROOT, 'profile');
    safeRmSync(ROOT, { recursive: true, force: true });
    withExecutionContext('sovereign_concierge', () => {
      safeMkdir(path.join(REPO, 'knowledge', 'personal', 'tenants'), { recursive: true });
      safeWriteFile(
        path.join(REPO, 'knowledge', 'personal', 'tenants', 'acme.json'),
        JSON.stringify({
          tenant_slug: 'acme',
          display_name: 'Acme',
          status: 'active',
          assigned_role: 'owner',
        })
      );
    });
    vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
  });

  afterEach(() => {
    for (const request of attestationRequests()) {
      safeRmSync(approvalRequestLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, request.id), {
        force: true,
      });
    }
    safeRmSync(approvalEventLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL), { force: true });
    vi.restoreAllMocks();
    safeRmSync(ROOT, { recursive: true, force: true });
  });

  const attestation = (provider: string) =>
    withExecutionContext('sovereign_concierge', () => readTenantProfile('acme', { rootDir: REPO }))
      ?.provider_attestations?.[provider];

  it('is opt-in: the default answer records and requests nothing', async () => {
    const { deps } = scripted([]);
    expect(await promptProviderAttestation(['acme'], deps)).toEqual({ outcome: 'declined' });
    expect(attestation('claude')).toBeUndefined();
    expect(attestationRequests()).toHaveLength(0);
  });

  it('training_use none opens an approval request, prints the approve command, and does not approve', async () => {
    const { deps, printed } = scripted([
      'y',
      'claude',
      'none',
      'Claude Team',
      'https://www.anthropic.com/legal/commercial-terms',
      'human:owner',
      'y',
    ]);
    const result = await promptProviderAttestation(['acme'], deps);
    expect(result.outcome).toBe('requested');
    const [request] = attestationRequests();
    expect(request).toMatchObject({ id: result.request_id, status: 'pending' });
    const output = printed.join('\n');
    expect(output).toContain(`pnpm kyberion approvals --approve ${result.request_id}`);
    expect(output).toContain(`--approval-request-id ${result.request_id}`);
    expect(output).toContain('LLM availability by data tier (tenant acme)');
    expect(attestation('claude')).toBeUndefined();
  });

  it('nothing is requested when the final confirmation is declined', async () => {
    const { deps } = scripted([
      'y',
      'claude',
      'none',
      'Claude Team',
      'https://www.anthropic.com/legal/commercial-terms',
      'human:owner',
      '',
    ]);
    expect((await promptProviderAttestation(['acme'], deps)).outcome).toBe('cancelled');
    expect(attestationRequests()).toHaveLength(0);
  });

  it('records used/unknown after the explicit confirmation and shows availability', async () => {
    const { deps, printed } = scripted(['y', 'codex', 'used', 'Free', '', 'human:owner', 'y']);
    expect((await promptProviderAttestation(['acme'], deps)).outcome).toBe('applied');
    expect(attestation('codex')).toMatchObject({ training_use: 'used' });
    expect(printed.join('\n')).toContain('LLM availability by data tier (tenant acme)');
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'wizard-operator', action: 'tenant.attest_provider' })
    );
  });
});
