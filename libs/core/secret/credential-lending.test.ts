/**
 * Credential custody / kind lending at bind (use) time (design §2.3, §2.5, §3; review B1, S1–S6, Q1).
 * Hermetic: grants, connection files, records, approvals, audit and directory creation are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantRecord } from '../governance/grant-store.js';
import {
  resolveTaskCredential,
  resolveTaskCredentialKind,
  resolveTaskProviderEnvironment,
  withTaskCredentialBinding,
} from '../foundation/credential-binding.js';
import { withExecutionContext } from '../authority.js';
import {
  credentialMaterialGrantAllows,
  isCredentialMaterialCapability,
} from '../foundation/credential-material-capability.js';
import { currentResourceAccessScope } from '../foundation/resource-access-scope.js';
import {
  buildCredentialRecord,
  credentialConnectionPath,
  credentialRecordPath,
  lendingFromRecord,
  parseCredentialRef,
  type CredentialEligibilityDeps,
  type CredentialRecord,
} from './credential-custody.js';
import { resetCredentialBudgetCache } from './credential-usage-ledger.js';
import { storeRelativePath } from '../path-resolver.js';

const state = vi.hoisted(() => ({
  grants: [] as GrantRecord[],
  revoked: new Set<string>(),
  files: {} as Record<string, Record<string, unknown>>,
  reads: [] as string[],
  audits: [] as Array<{ action: string; metadata: Record<string, unknown> }>,
  mkdirs: [] as string[],
  writes: [] as string[],
  approvalRequests: [] as unknown[],
  approvalConsumed: [] as unknown[],
}));
vi.mock('../governance/grant-store.js', () => ({
  registerCredentialLendingPolicy: () => undefined,
  listGrants: () => state.grants,
  loadGrant: (_tenant: string, id: string) => state.grants.find((g) => g.grant_id === id) ?? null,
  verifyGrantBasis: () => true,
  grantStatusAt: (grant: GrantRecord) => (state.revoked.has(grant.grant_id) ? 'revoked' : 'active'),
}));
vi.mock('./shell-task-credential-binding.js', () => ({
  assertTaskCredentialClaim: () => 'claim-a',
}));
vi.mock('./credential-custody-approval.js', () => ({
  requestCredentialCustodyApproval: (effect: unknown) => {
    state.approvalRequests.push(effect);
    return { id: 'APR-overwrite' };
  },
  consumeCredentialCustodyApproval: (
    effect: unknown,
    id: string,
    accept: (decider: string) => boolean
  ) => {
    // The approval binds exactly the requested effect (every record term + fingerprint).
    if (
      id !== 'APR-overwrite' ||
      !accept('user:cfo') ||
      JSON.stringify(effect) !== JSON.stringify(state.approvalRequests.at(-1))
    )
      throw new Error(
        '[CREDENTIAL_CUSTODY_APPROVAL_INVALID] approval is bound to a different effect'
      );
    state.approvalConsumed.push(effect);
    return { humanDecider: 'user:cfo', approvalId: id, consumedAt: 'now' };
  },
}));
vi.mock('../governance/audit-chain.js', async (original) => {
  const actual = await original<typeof import('../governance/audit-chain.js')>();
  const record = (entry: { action: string; metadata: Record<string, unknown> }) => {
    state.audits.push({ action: entry.action, metadata: entry.metadata });
    return { id: `audit-${state.audits.length}` };
  };
  return { ...actual, auditChain: { ...actual.auditChain, record, recordDurable: record } };
});
vi.mock('../secure-io.js', async (original) => {
  const actual = await original<typeof import('../secure-io.js')>();
  const rel = (target: string) => storeRelativePath(String(target));
  return {
    ...actual,
    safeMkdir: (target: string) => {
      state.mkdirs.push(String(target));
    },
    safeWriteFile: (target: string, content: string) => {
      state.writes.push(String(target));
      const key = Object.keys(state.files).find((suffix) => String(target).endsWith(suffix));
      state.files[key ?? rel(target)] = JSON.parse(content);
    },
    safeExistsSync: (target: string) =>
      Object.keys(state.files).some((suffix) => String(target).endsWith(suffix)) ||
      actual.safeExistsSync(target),
  };
});
vi.mock('../foundation/json.js', async (original) => {
  const actual = await original<typeof import('../foundation/json.js')>();
  return {
    ...actual,
    readJson: (file: string) => {
      const normalized = file.replaceAll('\\', '/');
      const key = Object.keys(state.files).find((suffix) => normalized.endsWith(suffix));
      if (!key) return actual.readJson(file);
      state.reads.push(key);
      // Only the brokered exact capability may read; another tenant's file stays denied.
      expect(isCredentialMaterialCapability(currentResourceAccessScope())).toBe(true);
      expect(credentialMaterialGrantAllows(key, 'read')).toBe(true);
      expect(
        credentialMaterialGrantAllows(
          'knowledge/confidential/gamma/connections/anthropic.json',
          'read'
        )
      ).toBe(false);
      return state.files[key];
    },
  };
});

import {
  bindAllocatedTaskCredentials,
  claudeNetworkPassthroughEnv,
  registerTenantCredential,
  setCredentialLendingDepsForTests,
} from './credential-allocations.js';

const NOW = new Date();
let personalOwners: Record<string, string> = {};
let attested = new Set<string>();
let history: Record<string, unknown>[] = [];
const deps: CredentialEligibilityDeps = {
  personalOwnerOf: (tenant) => personalOwners[tenant],
  installationPerson: () => 'owner',
  borrowerAttested: (tenant) => attested.has(tenant),
};
const tenantOwners: Record<string, string[]> = { cfo: ['parent'], owner: ['home'] };

function register(
  credentialRef: string,
  value: string,
  extra: Partial<Parameters<typeof buildCredentialRecord>[0]> = {}
): CredentialRecord {
  const ref = parseCredentialRef(credentialRef);
  const record = buildCredentialRecord({
    credentialRef,
    value,
    registeredBy: 'user:owner',
    now: NOW,
    ...extra,
  });
  const field = ref.service === 'anthropic' ? 'api_key' : 'oauth_token';
  state.files[credentialConnectionPath(ref)] = { [field]: value };
  state.files[credentialRecordPath(ref)] = { ...record };
  return record;
}
function lendingGrant(
  id: string,
  borrower: string,
  record: CredentialRecord,
  budgetMonthlyUsd?: number
): GrantRecord {
  const lending = lendingFromRecord(record, { budgetMonthlyUsd });
  const service = lending.service;
  return {
    schema_version: 'grant-record.v1',
    grant_id: id,
    capability: 'credential.use',
    scope: {
      tenant_slug: borrower,
      credential_provider: service === 'anthropic' ? 'anthropic' : 'claude-cli',
      credential_ref:
        service === 'anthropic' ? 'anthropic/API_KEY' : 'claude-subscription/OAUTH_TOKEN',
      credential_lending: lending,
    },
    purpose: 'resident dot',
    granted_by: { actor_id: 'user:owner', role: 'operator', assurance: 'A1' },
    granted_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 86400000).toISOString(),
    audit_event_id: 'audit',
  };
}
const bindAs = <T>(tenant: string, run: () => Promise<T>) =>
  withExecutionContext('sovereign_concierge', run, 'sovereign', tenant, undefined, {
    missionId: 'MSN-LEND',
    taskId: 'task-a',
  });
const input = (tenant: string) => ({
  scope: {
    tier: 'confidential' as const,
    tenant_slug: tenant,
    mission_id: 'MSN-LEND',
    task_id: 'task-a',
  },
  workItemId: 'WI-lend',
});

beforeEach(() => {
  Object.assign(state, {
    grants: [],
    files: {},
    reads: [],
    audits: [],
    mkdirs: [],
    writes: [],
    approvalRequests: [],
    approvalConsumed: [],
  });
  state.revoked.clear();
  personalOwners = { home: 'user:owner' };
  attested = new Set(['home', 'parent', 'child']);
  history = [];
  resetCredentialBudgetCache();
  setCredentialLendingDepsForTests({
    eligibility: deps,
    usageHistory: () => history,
    tenantOwnerMember: (member, tenant) => tenantOwners[member]?.includes(tenant) ?? false,
  });
});

describe('lent credential binding (design §3 output)', () => {
  it('lends a parent tenant API key to a subsidiary: brokered read, audit row, isolated HOME, no copy', async () => {
    const record = register('tenant:parent:anthropic', 'sk-ant-parent-key-0001');
    state.grants = [lendingGrant('GRT-1', 'child', record)];
    await bindAs('child', async () => {
      const binding = await bindAllocatedTaskCredentials(input('child'));
      expect(binding?.secrets).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-parent-key-0001' });
      expect(binding?.credentialKind).toBe('api_key');
      expect(binding?.credentialSource).toEqual({
        credentialRef: 'tenant:parent:anthropic',
        allocationGrantId: 'GRT-1',
      });
      const env = binding!.providerEnvironments!.claude!;
      expect(env.HOME).toMatch(
        /active\/shared\/cache\/confidential\/child\/provider-auth\/claude\/[0-9a-f]{16}\/home$/
      );
      expect(env.CLAUDE_CONFIG_DIR).toBe(`${env.HOME}/.claude`);
      expect(Object.values(env)).not.toContain('sk-ant-parent-key-0001');
      const lent = state.audits.filter((entry) => entry.action === 'credential.lent_read');
      expect(lent).toHaveLength(1);
      expect(lent[0]!.metadata).toMatchObject({
        credential_ref: 'tenant:parent:anthropic',
        borrower_tenant: 'child',
        owner_tenant: 'parent',
        grant_id: 'GRT-1',
        mission_id: 'MSN-LEND',
        task_id: 'task-a',
      });
      expect(state.writes).toEqual([]);
      expect(state.mkdirs.every((dir) => dir.includes('/cache/confidential/child/'))).toBe(true);
      await withTaskCredentialBinding(binding!, async () => {
        expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('sk-ant-parent-key-0001');
        expect(resolveTaskCredentialKind()).toBe('api_key');
        expect(resolveTaskProviderEnvironment('claude')?.HOME).toBe(env.HOME);
      });
    });
  });

  it('refuses a substituted value until the owner re-approves ([CREDENTIAL_VALUE_CHANGED])', async () => {
    const record = register('tenant:parent:anthropic', 'sk-ant-parent-key-0001');
    state.grants = [lendingGrant('GRT-V', 'child', record)];
    state.files['knowledge/confidential/parent/connections/anthropic.json'] = {
      api_key: 'sk-ant-substituted-9999',
    };
    await bindAs('child', async () => {
      await expect(bindAllocatedTaskCredentials(input('child'))).rejects.toThrow(
        /\[CREDENTIAL_VALUE_CHANGED\]/
      );
    });
  });

  it('refuses a grant whose record was re-registered with other terms', async () => {
    const record = register('person:owner:claude-subscription', 'sk-ant-oat-home-0001', {
      plan: 'pro',
    });
    state.grants = [lendingGrant('GRT-R', 'home', record)];
    state.files['knowledge/personal/connections/claude-subscription.record.json'] = {
      ...record,
      plan: 'max',
    };
    await bindAs('home', async () => {
      await expect(bindAllocatedTaskCredentials(input('home'))).rejects.toThrow(
        /\[CREDENTIAL_RECORD_MISMATCH\]/
      );
    });
  });

  it('binds a home Pro setup-token for the explicit personal tenant; generic reads cannot see it (Q1)', async () => {
    const { getSecret } = await import('./secret-guard.js');
    const { applyClaudeTenantIsolationEnv } =
      await import('../provider/claude-cli-tenant-isolation.js');
    const record = register('person:owner:claude-subscription', 'sk-ant-oat-home-token-0001', {
      plan: 'pro',
    });
    state.grants = [lendingGrant('GRT-2', 'home', record)];
    await bindAs('home', async () => {
      const binding = await bindAllocatedTaskCredentials(input('home'));
      expect(binding?.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-home-token-0001' });
      expect(binding?.credentialKind).toBe('subscription_token');
      expect(state.audits.filter((entry) => entry.action === 'credential.lent_read')).toEqual([]);
      await withTaskCredentialBinding(binding!, async () => {
        expect(resolveTaskCredential('CLAUDE_CODE_OAUTH_TOKEN')).toBeNull();
        expect(getSecret('CLAUDE_CODE_OAUTH_TOKEN')).toBeFalsy();
        const bound = resolveTaskProviderEnvironment('claude')!;
        const env = applyClaudeTenantIsolationEnv(
          { ...bound } as Record<string, string>,
          bound,
          '/usr/bin'
        );
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-home-token-0001');
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      });
    });
  });

  it('refuses a consumer token on a company tenant whose owner membership is only bootstrapped (B1)', async () => {
    const record = register('person:owner:claude-subscription', 'sk-ant-oat-home-0001', {
      plan: 'max',
    });
    state.grants = [lendingGrant('GRT-3', 'parent', record)];
    await bindAs('parent', async () => {
      await expect(bindAllocatedTaskCredentials(input('parent'))).rejects.toThrow(
        /\[CREDENTIAL_KIND_NOT_ELIGIBLE\].*tenant personal-owner --tenant parent/
      );
    });
    expect(state.reads.filter((file) => file.endsWith('claude-subscription.json'))).toEqual([]);
  });

  it('stops at bind once personal_owner is cleared after approval', async () => {
    const record = register('person:owner:claude-subscription', 'sk-ant-oat-home-0001', {
      plan: 'pro',
    });
    state.grants = [lendingGrant('GRT-4', 'home', record)];
    personalOwners = {};
    await bindAs('home', async () => {
      await expect(bindAllocatedTaskCredentials(input('home'))).rejects.toThrow(
        /CREDENTIAL_KIND_NOT_ELIGIBLE/
      );
    });
  });

  it('refuses a person ref naming another member (confused deputy, S1)', async () => {
    const record = register('person:alice:anthropic', 'sk-ant-owner-personal-0001');
    state.grants = [lendingGrant('GRT-5', 'child', record)];
    await bindAs('child', async () => {
      await expect(bindAllocatedTaskCredentials(input('child'))).rejects.toThrow(
        /\[CREDENTIAL_CUSTODY_PERSON_MISMATCH\]/
      );
    });
    expect(state.reads).toEqual([]);
  });

  it('requires the borrower attestation for an API key', async () => {
    const record = register('tenant:parent:anthropic', 'sk-ant-parent-key-0001');
    state.grants = [lendingGrant('GRT-6', 'child', record)];
    attested.delete('child');
    await bindAs('child', async () => {
      await expect(bindAllocatedTaskCredentials(input('child'))).rejects.toThrow(
        /\[CREDENTIAL_ATTESTATION_REQUIRED\].*llm attest --tenant child --provider claude/
      );
    });
  });

  it('stops at 100% of the budget at bind and during a long binding (S4)', async () => {
    const record = register('tenant:parent:anthropic', 'sk-ant-parent-key-0001');
    state.grants = [lendingGrant('GRT-7', 'child', record, 10)];
    const spent = (cost: number) => ({
      timestamp: new Date().toISOString(),
      credential_ref: 'tenant:parent:anthropic',
      scope: { tenant_slug: 'child' },
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      cost_usd: cost,
      agent: 'claude-cli',
    });
    await bindAs('child', async () => {
      const binding = await bindAllocatedTaskCredentials(input('child'));
      await withTaskCredentialBinding(binding!, async () => {
        expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('sk-ant-parent-key-0001');
        history = [spent(10.5)];
        resetCredentialBudgetCache();
        expect(() => resolveTaskCredential('ANTHROPIC_API_KEY')).toThrow(
          /CREDENTIAL_BUDGET_EXCEEDED/
        );
      });
      await expect(bindAllocatedTaskCredentials(input('child'))).rejects.toThrow(
        /\[CREDENTIAL_BUDGET_EXCEEDED\]/
      );
    });
  });

  it('A spawn: key and CA reach the child; revocation fails at spawn; redaction keeps the launch value (S5)', async () => {
    const isolation = await import('../provider/claude-cli-tenant-isolation.js');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/etc/corp-ca.pem');
    const record = register('tenant:parent:anthropic', 'sk-ant-parent-key-0001');
    state.grants = [lendingGrant('GRT-8', 'child', record)];
    try {
      await bindAs('child', async () => {
        const binding = await bindAllocatedTaskCredentials(input('child'));
        expect(binding?.providerEnvironments?.claude?.NODE_EXTRA_CA_CERTS).toBe('/etc/corp-ca.pem');
        await withTaskCredentialBinding(binding!, async () => {
          const bound = resolveTaskProviderEnvironment('claude')!;
          const env = isolation.applyClaudeTenantIsolationEnv(
            { ...bound } as Record<string, string>,
            bound,
            '/usr/bin'
          );
          expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-parent-key-0001');
          expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/corp-ca.pem');
          const launch = isolation.prepareClaudeBoundLaunch(['-p', 'x'])!;
          state.revoked.add('GRT-8');
          expect(() =>
            isolation.applyClaudeTenantIsolationEnv(
              { ...bound } as Record<string, string>,
              bound,
              '/usr/bin'
            )
          ).toThrow(/CREDENTIAL_ALLOCATION_DENIED/);
          expect(isolation.boundClaudeCredentialValues()).toContain('sk-ant-parent-key-0001');
          launch.dispose();
          expect(isolation.boundClaudeCredentialValues()).not.toContain('sk-ant-parent-key-0001');
        });
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('redacts a stream error raised after the launch was disposed and the grant revoked (re-review 7)', async () => {
    const isolation = await import('../provider/claude-cli-tenant-isolation.js');
    const { redactProviderOutputStream } = await import('../provider/provider-output-redaction.js');
    const record = register('tenant:parent:anthropic', 'sk-ant-parent-key-0001');
    state.grants = [lendingGrant('GRT-S', 'child', record)];
    await bindAs('child', async () => {
      const binding = await bindAllocatedTaskCredentials(input('child'));
      await withTaskCredentialBinding(binding!, async () => {
        async function* cli(): AsyncGenerator<string> {
          const launch = isolation.prepareClaudeBoundLaunch(['-p', 'x'])!;
          try {
            yield 'partial ';
            throw new Error('claude failed: key sk-ant-parent-key-0001 rejected');
          } finally {
            state.revoked.add('GRT-S');
            launch.dispose();
          }
        }
        const chunks: string[] = [];
        let failure: unknown;
        try {
          for await (const chunk of redactProviderOutputStream(cli())) chunks.push(chunk);
        } catch (error) {
          failure = error;
        }
        expect(String((failure as Error).message)).not.toContain('sk-ant-parent-key-0001');
      });
    });
  });

  it('keeps legacy person API-key grants working (backward compatible)', async () => {
    state.files['knowledge/personal/connections/anthropic.json'] = {
      api_key: 'sk-ant-legacy-key-0001',
    };
    state.grants = [
      {
        ...lendingGrant(
          'GRT-9',
          'parent',
          buildCredentialRecord({
            credentialRef: 'tenant:parent:anthropic',
            value: 'x'.repeat(12),
            registeredBy: 'user:owner',
          })
        ),
        scope: {
          tenant_slug: 'parent',
          credential_provider: 'anthropic',
          credential_ref: 'anthropic/API_KEY',
        },
      },
    ];
    await bindAs('parent', async () => {
      const binding = await bindAllocatedTaskCredentials(input('parent'));
      expect(binding?.secrets).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-legacy-key-0001' });
      expect(binding?.credentialKind).toBe('api_key');
      expect(binding?.providerEnvironments).toBeUndefined();
    });
  });
});

describe('tenant credential registration (S3)', () => {
  const asOperator = <T>(run: () => T) =>
    withExecutionContext('credential_allocation_manager', run, undefined, 'parent');

  it('registers first, then requires an owner approval bound to the new fingerprint to overwrite', () => {
    const first = asOperator(() =>
      registerTenantCredential({
        credentialRef: 'tenant:parent:anthropic',
        value: 'sk-ant-first-0001',
        registeredBy: 'user:cfo',
      })
    );
    expect(first.status).toBe('registered');
    expect(state.audits.map((entry) => entry.action)).toContain('credential.registered');
    expect(JSON.stringify(state.audits)).not.toContain('sk-ant-first-0001');
    const pending = asOperator(() =>
      registerTenantCredential({
        credentialRef: 'tenant:parent:anthropic',
        value: 'sk-ant-second-0002',
        registeredBy: 'user:cfo',
      })
    );
    expect(pending).toMatchObject({ status: 'approval_required', approval_id: 'APR-overwrite' });
    expect(
      (
        state.files['knowledge/confidential/parent/connections/anthropic.json'] as {
          api_key: string;
        }
      ).api_key
    ).toBe('sk-ant-first-0001');
    const applied = asOperator(() =>
      registerTenantCredential({
        credentialRef: 'tenant:parent:anthropic',
        value: 'sk-ant-second-0002',
        registeredBy: 'user:cfo',
        approvalRequestId: 'APR-overwrite',
      })
    );
    expect(applied.status).toBe('registered');
    expect(state.audits.map((entry) => entry.action)).toContain('credential.replaced');
  });

  it('binds every record term into the overwrite approval: a changed plan needs a new approval', () => {
    asOperator(() =>
      registerTenantCredential({
        credentialRef: 'tenant:parent:claude-subscription',
        value: 'sk-ant-oat-seat-0001',
        plan: 'team',
        registeredBy: 'user:cfo',
      })
    );
    asOperator(() =>
      registerTenantCredential({
        credentialRef: 'tenant:parent:claude-subscription',
        value: 'sk-ant-oat-seat-0001',
        plan: 'team',
        registeredBy: 'user:cfo',
      })
    );
    expect(state.approvalRequests.at(-1)).toMatchObject({
      action: 'tenant_credential_overwrite',
      kind: 'subscription_token',
      plan: 'team',
      terms: 'commercial',
      contract_tenant: 'parent',
      token_expires_at: expect.any(String),
      value_fingerprint: expect.stringMatching(/^sha256:/),
    });
    expect(() =>
      asOperator(() =>
        registerTenantCredential({
          credentialRef: 'tenant:parent:claude-subscription',
          value: 'sk-ant-oat-seat-0001',
          plan: 'enterprise',
          registeredBy: 'user:cfo',
          approvalRequestId: 'APR-overwrite',
        })
      )
    ).toThrow(/bound to a different effect/);
  });

  it('cannot be issued by a SYSTEM_ROLE surface or daemon (custody store right is unshared)', () => {
    vi.stubEnv('SYSTEM_ROLE', 'telegram_bridge');
    try {
      expect(() =>
        asOperator(() =>
          registerTenantCredential({
            credentialRef: 'tenant:parent:anthropic',
            value: 'sk-ant-first-0001',
            registeredBy: 'user:cfo',
          })
        )
      ).toThrow(/ROLE_ASSUMPTION_DENIED/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(state.writes).toEqual([]);
  });

  it('refuses a non-owner registrant', () => {
    expect(() =>
      asOperator(() =>
        registerTenantCredential({
          credentialRef: 'tenant:parent:anthropic',
          value: 'sk-ant-first-0001',
          registeredBy: 'user:owner',
        })
      )
    ).toThrow(/CREDENTIAL_OWNER_REQUIRED/);
  });
});

describe('claude network passthrough (corporate proxy / CA, N1)', () => {
  it('passes CA and proxy routing, never proxy credentials', () => {
    expect(
      claudeNetworkPassthroughEnv({
        NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem',
        HTTPS_PROXY: 'http://proxy.corp:8080',
        NO_PROXY: 'localhost',
        HTTP_PROXY: 'http://user:secret@proxy.corp:8080',
        https_proxy: 'user:secret@proxy.corp:8080',
        ANTHROPIC_API_KEY: 'sk-operator',
      })
    ).toEqual({
      NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem',
      HTTPS_PROXY: 'http://proxy.corp:8080',
      NO_PROXY: 'localhost',
    });
  });
});
