import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinatedAgentExecutionPort } from '../coordinated-agent-execution-port.js';
import {
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  clearWorkCoordinationStore,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';
import {
  mintScopeEnvelope,
  resetScopeEnvelopeState,
  withScopeEnvelope,
} from '../scope-envelope.js';
import { resolveTaskCredential } from '../foundation/credential-binding.js';
import { resetSecretResolver } from './secret-resolver.js';
import { installLocalCredentialAllocations } from './credential-allocations.js';
const state = vi.hoisted(() => ({ revoked: false, read: vi.fn() }));
const tenant = 'vitest-local-allocation';
const mission = 'MSN-LOCAL-ALLOCATION';
const task = 'task-probe';
const actor = 'kyberion://agent/vitest-local/worker';
const grant = () => ({
  grant_id: 'GRT-20261101-123456abcdef',
  capability: 'credential.use',
  scope: {
    tenant_slug: tenant,
    credential_provider: 'anthropic',
    credential_ref: 'anthropic/API_KEY',
  },
});
vi.mock('../governance/grant-store.js', () => ({
  listGrants: () => [grant()],
  loadGrant: () => grant(),
  grantStatusAt: () => (state.revoked ? 'revoked' : 'active'),
  verifyGrantBasis: () => true,
}));
vi.mock('../foundation/json.js', async (original) => {
  const actual = await original<typeof import('../foundation/json.js')>();
  return {
    ...actual,
    readJson: (path: string) => {
      if (path.replaceAll('\\', '/').endsWith('/knowledge/personal/connections/anthropic.json')) {
        state.read();
        return { api_key: 'synthetic-allocated-key' };
      }
      return actual.readJson(path);
    },
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  state.revoked = false;
  resetSecretResolver();
  installLocalCredentialAllocations();
  resetScopeEnvelopeState();
  setWorkCoordinationNamespace(`vitest-local-allocation-${randomUUID()}`);
  vi.stubEnv('KYBERION_SCOPE_ENV_PATH', 'active/shared/tmp/vitest-local-allocation-no-scope.env');
  for (const key of [
    'KYBERION_TENANT',
    'KYBERION_PROJECT_ID',
    'KYBERION_ORGANIZATION_ID',
    'MISSION_ID',
    'KYBERION_TASK_ID',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-operator-only');
});
afterEach(() => {
  clearWorkCoordinationStore();
  setWorkCoordinationNamespace(null);
  resetSecretResolver();
  resetScopeEnvelopeState();
  vi.unstubAllEnvs();
});
describe('allocated credentials through real coordinated dispatch', () => {
  it('uses a real claim, binds the allocation, detects revocation on the next read and releases the lease', async () => {
    const item = createWorkItem({
      title: 'Allocation dispatch proof',
      description: 'Synthetic fixture only',
      status: 'ready',
      projectId: 'PRJ-ALLOCATION',
      context: {
        tenant_slug: tenant,
        organization_id: 'allocation-org',
        project_id: 'PRJ-ALLOCATION',
        mission_id: mission,
        task_id: task,
      },
    });
    const parent = mintScopeEnvelope({
      env: {
        KYBERION_TIER: 'confidential',
        KYBERION_TENANT: tenant,
        MISSION_ID: mission,
        KYBERION_ORGANIZATION_ID: 'allocation-org',
        KYBERION_PROJECT_ID: 'PRJ-ALLOCATION',
      },
      policy: { purpose: 'allocation composition' },
    });
    const port = new CoordinatedAgentExecutionPort(
      {
        delegate: async (request) => {
          expect(getWorkItem(item.item_id)?.claimed_by_peer_id).toBe(actor);
          expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBe('synthetic-allocated-key');
          state.revoked = true;
          expect(() => resolveTaskCredential('ANTHROPIC_API_KEY')).toThrow(
            'CREDENTIAL_ALLOCATION_DENIED'
          );
          state.revoked = false;
          return {
            execution_kind: 'agent_delegation',
            task_id: request.task_id,
            agent_id: actor,
            status: 'succeeded',
          };
        },
      },
      actor
    );
    const receipt = await withScopeEnvelope(parent, () =>
      port.delegate({
        work_item_id: item.item_id,
        task_id: task,
        mission_id: mission,
        instruction: 'Synthetic bounded credential check',
        idempotency_key: task,
        security_scope: {
          tenant_slug: tenant,
          organization_id: 'allocation-org',
          project_id: 'PRJ-ALLOCATION',
          mission_id: mission,
          read_tiers: ['confidential'],
          write_tier: 'confidential',
          purpose: 'allocation composition',
        },
      })
    );
    expect(receipt.status).toBe('succeeded');
    expect(state.read).toHaveBeenCalled();
    expect(getWorkItem(item.item_id)?.status).toBe('done');
    expect(listActiveWorkLeases()).toHaveLength(0);
    expect(resolveTaskCredential('ANTHROPIC_API_KEY')).toBeUndefined();
  });
});
