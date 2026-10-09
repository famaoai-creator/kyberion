import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The terminal records one stable operator principal on both sides of an
 * approval: the local owner member (`user:<member_id>`) when the CLI opens a
 * request (here: `pnpm onboarding llm attest --request-approval`, which
 * captures the invoker with `captureAttestationInvoker`) and when
 * `pnpm kyberion approvals --approve` decides it. The owner member and the
 * onboarding display name are stubbed; separation of duties is switched on
 * through a customer overlay of the real approval policy.
 */
const identity = vi.hoisted(() => ({ ownerPresent: true, displayName: 'Alice Example' }));

// Separation of duties is switched through a customer overlay of the real
// approval policy, the way an operator enables it.
const sod = vi.hoisted(() => ({ overlayPath: null as string | null, file: '' }));
vi.mock('@agent/core/customer-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/customer-resolver')>();
  return {
    ...actual,
    customerRoot: (subPath = '', ...rest: unknown[]) =>
      subPath === 'policy/approval-policy.json' && sod.overlayPath
        ? sod.overlayPath
        : (actual.customerRoot as (...args: unknown[]) => string | null)(subPath, ...rest),
  };
});

vi.mock('@agent/core/organization/member-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/organization/member-registry')>();
  return {
    ...actual,
    resolveMemberByPrincipal: (input: { source: string }) =>
      input.source === 'loopback' && identity.ownerPresent
        ? {
            member_id: 'owner',
            display_name: identity.displayName,
            status: 'active',
            memberships: [],
            access_registrations: [],
            created_at: '2026-10-01T00:00:00.000Z',
            updated_at: '2026-10-01T00:00:00.000Z',
          }
        : null,
  };
});

vi.mock('@agent/core/surface/operator-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/surface/operator-identity')>();
  return { ...actual, resolveOperatorDisplayName: () => identity.displayName };
});

import { withExecutionContext } from '@agent/core/authority';
import {
  approvalEventLogicalPath,
  approvalRequestLogicalPath,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import {
  attestTenantProvider,
  captureAttestationInvoker,
  mutateTenant,
  PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
  requestTenantProviderAttestationApproval,
} from '@agent/core/organization/tenant-governance';
import { CLI_AGENT_SESSION_ENV } from '@agent/core/governance/cli-operator-principal';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { main as kyberionHome } from './kyberion_home.js';

function useSeparationOfDutiesOverlay(file: string): void {
  sod.file = file;
}

function setSeparationOfDuties(enabled: boolean): void {
  const product = JSON.parse(
    String(
      safeReadFile(pathResolver.knowledge('product/governance/approval-policy.json'), {
        encoding: 'utf8',
      })
    )
  );
  safeMkdir(path.dirname(sod.file), { recursive: true });
  safeWriteFile(sod.file, JSON.stringify({ ...product, separation_of_duties: { enabled } }));
  sod.overlayPath = sod.file;
}

function clearSeparationOfDuties(): void {
  sod.overlayPath = null;
  if (sod.file) safeRmSync(sod.file, { force: true });
}

function plainTerminal(): void {
  for (const name of CLI_AGENT_SESSION_ENV) vi.stubEnv(name, '');
}

const claim = {
  slug: 'beta',
  provider: 'codex',
  training_use: 'none' as const,
  plan: 'ChatGPT Enterprise',
  basis: 'https://openai.com/enterprise-privacy',
  attested_by: 'human:owner',
};

describe('terminal approvals record one stable operator principal', () => {
  const parent = pathResolver.sharedTmp('approvals-cli-identity-tests');
  let rootDir = '';
  const requestIds: string[] = [];

  /** `pnpm onboarding llm attest … --request-approval`, as the CLI runs it. */
  function requestFromCli(overrides: Partial<typeof claim> = {}): string {
    const invoker = captureAttestationInvoker();
    const request = withExecutionContext('sovereign_concierge', () =>
      requestTenantProviderAttestationApproval({ ...claim, ...overrides, rootDir, invoker })
    );
    requestIds.push(request.request_id);
    return request.request_id;
  }

  async function approveFromCli(id: string): Promise<void> {
    await kyberionHome(['approvals', '--approve', id]);
  }

  const stored = (id: string) => loadApprovalRequest(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id)!;

  beforeEach(() => {
    plainTerminal();
    identity.ownerPresent = true;
    rootDir = path.join(parent, `fixture-${process.pid}-${Date.now()}-${Math.random()}`);
    useSeparationOfDutiesOverlay(path.join(rootDir, 'approval-policy-overlay.json'));
    safeMkdir(path.join(rootDir, 'knowledge', 'personal', 'tenants'), { recursive: true });
    withExecutionContext('sovereign_concierge', () =>
      mutateTenant({ verb: 'create', slug: 'beta', rootDir, apply: true })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSeparationOfDuties();
    for (const id of requestIds.splice(0)) {
      safeRmSync(approvalRequestLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, id), {
        force: true,
      });
    }
    safeRmSync(approvalEventLogicalPath(PROVIDER_ATTESTATION_APPROVAL_CHANNEL), { force: true });
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('with SoD on, refuses the operator approving the request they opened from the CLI', async () => {
    setSeparationOfDuties(true);
    const id = requestFromCli();
    expect(stored(id)).toMatchObject({
      requestedBy: 'user:owner',
      requestedByDisplayName: 'Alice Example',
    });

    await expect(approveFromCli(id)).rejects.toThrow(
      /\[POLICY_VIOLATION\] Separation of duties: approval refused because the decider is the same principal/
    );
    expect(stored(id).status).toBe('pending');
  });

  it('with SoD on, still lets the human approve a request an agent session opened', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    expect(stored(id).requestedBy).toBe('agent:claude-code');

    plainTerminal();
    await approveFromCli(id);
    expect(stored(id)).toMatchObject({
      status: 'approved',
      decidedBy: 'user:owner',
      decidedByDisplayName: 'Alice Example',
    });
  });

  it('with SoD on, refuses to approve from inside an agent session', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('KYBERION_AGENT_ID', 'planner');
    const id = requestFromCli();
    expect(stored(id).requestedBy).toBe('agent:planner');

    vi.stubEnv('KYBERION_AGENT_ID', 'reviewer');
    await expect(approveFromCli(id)).rejects.toThrow(
      /approval decision blocked — separation of duties is on and this command runs inside an agent session \(agent:reviewer\)/
    );
    expect(stored(id).status).toBe('pending');
  });

  it('with SoD on and no owner member, reports the missing identity instead of using a placeholder', async () => {
    setSeparationOfDuties(true);
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    plainTerminal();
    identity.ownerPresent = false;

    await expect(approveFromCli(id)).rejects.toThrow(
      /approval decision blocked — separation of duties is on and this terminal has no stable operator identity.*pnpm organization member ensure-owner/
    );
    expect(stored(id).status).toBe('pending');
    // Opening a new request (a different claim) is refused the same way.
    expect(() => requestFromCli({ plan: 'ChatGPT Team' })).toThrow(
      /approval request blocked — .*no stable operator identity.*pnpm organization member ensure-owner/
    );
  });

  it('with SoD off and no owner member, keeps the previous records (persona requester, display-name decider)', async () => {
    identity.ownerPresent = false;
    const id = requestFromCli();
    expect(stored(id).requestedBy).not.toMatch(/^(user|agent):/);

    await approveFromCli(id);
    expect(stored(id)).toMatchObject({ status: 'approved', decidedBy: 'Alice Example' });
  });

  it('revokes an approved, unused approval from the terminal so no consumer can use it', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    const id = requestFromCli();
    plainTerminal();
    await approveFromCli(id);

    const output: unknown[] = [];
    await kyberionHome(['approvals', '--revoke', id, '--reason', 'approved the wrong plan'], (v) =>
      output.push(v)
    );
    expect(String(output.at(-1))).toContain(`${id} → revoked`);
    expect(stored(id)).toMatchObject({
      status: 'approved',
      revocation: {
        revokedBy: 'user:owner',
        revokedByDisplayName: 'Alice Example',
        reason: 'approved the wrong plan',
      },
    });

    // The attestation consumer refuses it (separation of duties is off).
    expect(() =>
      withExecutionContext('sovereign_concierge', () =>
        attestTenantProvider({
          ...claim,
          rootDir,
          invoker: { actor: 'operator-cli' },
          approvalRequestId: id,
        })
      )
    ).toThrow(/cannot be used because it was revoked by user:owner/);
    // Re-requesting opens a fresh request instead of handing back the revoked one.
    vi.stubEnv('CLAUDECODE', '1');
    expect(requestFromCli()).not.toBe(id);

    // A revoked (or unknown) id is no longer revocable.
    plainTerminal();
    await expect(kyberionHome(['approvals', '--revoke', id])).rejects.toThrow();
  });

  it('with SoD off, an operator still approves their own CLI request (now recorded as user:owner)', async () => {
    const id = requestFromCli();
    await approveFromCli(id);
    expect(stored(id)).toMatchObject({
      status: 'approved',
      requestedBy: 'user:owner',
      decidedBy: 'user:owner',
    });
  });
});
