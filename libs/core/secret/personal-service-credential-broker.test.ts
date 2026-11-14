import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PersonalCredentialClaim,
  PersonalServiceCredentialBinding,
} from '../foundation/credential-binding.js';
import type { PersonalCredentialGrantRecord } from '../governance/personal-credential-grant-scope.js';
import type { ServiceBindingRecord } from '../service/service-binding-registry.js';
import type { LocalAccountRegistrationState } from './secret-guard.js';

interface PresetFixture {
  service_id: string;
  auth_strategy: string;
  operations: Record<
    string,
    {
      type: string;
      method: string;
      path: string;
      risk: string;
      approval_required: boolean;
      alternatives?: Array<{ type: string }>;
    }
  >;
}

const mocks = vi.hoisted(() => ({
  identity: {} as { personalClaim: PersonalCredentialClaim; missionId: string; taskId: string },
  envelope: {} as {
    policy: { read_tiers: string[]; write_tier: string };
    identity: { tier: string; project_id: string; mission_id: string; task_id: string };
  },
  grant: {} as PersonalCredentialGrantRecord,
  approval: {} as Record<string, unknown>,
  binding: {} as ServiceBindingRecord,
  endpoint: {} as { base_url: string; credential_suffixes: { accessToken: string[] } },
  preset: {} as PresetFixture,
  registration: {} as LocalAccountRegistrationState,
  material: {} as Record<string, string>,
  overlay: {} as PersonalServiceCredentialBinding,
  loadMaterial: vi.fn(),
  claim: vi.fn(),
  resolver: {} as object | null,
  localResolver: {} as object,
}));
vi.mock('./secret-resolver.js', () => ({ getSecretResolver: () => mocks.resolver }));
vi.mock('./credential-allocations.js', () => ({
  isLocalCredentialAllocationResolver: (value: unknown) => !!value && value === mocks.localResolver,
}));
vi.mock('../foundation/credential-binding.js', async (original) => ({
  ...(await original<typeof import('../foundation/credential-binding.js')>()),
  credentialExecutionIdentity: () => mocks.identity,
  withPersonalServiceCredentialBinding: async (
    source: PersonalServiceCredentialBinding,
    run: () => Promise<unknown>
  ) => {
    mocks.overlay = source;
    source.validate();
    return run();
  },
}));
vi.mock('../foundation/personal-credential-use-capability.js', () => ({
  withPersonalCredentialUseCapability: (_input: unknown, run: () => unknown) => run(),
}));
vi.mock('./personal-task-credential-claim.js', () => ({
  assertPersonalTaskCredentialClaim: mocks.claim,
}));
vi.mock('../scope-envelope.js', async (original) => ({
  ...(await original<typeof import('../scope-envelope.js')>()),
  currentScopeEnvelope: () => mocks.envelope,
}));
vi.mock('../governance/personal-credential-grant-runtime-reader.js', () => ({
  loadPersonalRuntimeCredentialGrant: () => mocks.grant,
  loadPersonalRuntimeCredentialApproval: () => mocks.approval,
  personalCredentialApprovalPath: () => 'synthetic-exact-approval',
}));
vi.mock('../service/service-binding-reader.js', () => ({
  loadServiceBindingRecord: () => mocks.binding,
}));
vi.mock('../service/service-endpoint-registry.js', async (original) => ({
  ...(await original<typeof import('../service/service-endpoint-registry.js')>()),
  getServiceEndpointRecord: () => mocks.endpoint,
}));
vi.mock('../service/service-preset-registry.js', () => ({
  getServicePresetRecord: () => mocks.preset,
}));
vi.mock('../shell/sandbox-policy.js', async (original) => ({
  ...(await original<typeof import('../shell/sandbox-policy.js')>()),
  getPluginExecutionContext: () => null,
  assertPluginGrantAllows: vi.fn(),
}));
vi.mock('./secret-guard.js', async (original) => ({
  ...(await original<typeof import('./secret-guard.js')>()),
  localAccountMaterialAccountId: () => 'a'.repeat(64),
  loadPersonalRuntimeAccountRegistration: () => mocks.registration,
  loadPersonalRuntimeAccountMaterial: () => {
    mocks.loadMaterial();
    return mocks.material;
  },
}));
import {
  withPersonalServiceCredentialUse,
  resolvePersonalServiceCredentialAdmission,
} from './personal-service-credential-broker.js';
import {
  personalCredentialGrantEffect,
  personalCredentialGrantPayload,
} from '../governance/personal-credential-grant-scope.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';

const selected = {
  serviceId: 'slack',
  action: 'search_messages',
  bindingId: 'my-slack',
  grantId: 'GRT-20261114-123456abcdef',
};
function seed() {
  mocks.resolver = mocks.localResolver = {};
  const claim = Object.freeze({
    ownerId: 'user:owner',
    actorId: 'kyberion://agent/_/_/worker',
    workItemId: 'work-a',
    attemptId: 'run-a',
    leaseId: 'lease-a',
  });
  mocks.identity = { personalClaim: claim, missionId: 'MSN-A', taskId: 'task-a' };
  mocks.claim.mockImplementation(() => ({ ...claim }));
  mocks.envelope = {
    policy: { read_tiers: ['public'], write_tier: 'public' },
    identity: { tier: 'public', project_id: 'project-a', mission_id: 'MSN-A', task_id: 'task-a' },
  };
  mocks.binding = {
    binding_id: selected.bindingId,
    service_id: 'slack',
    service_type: 'slack',
    owner_kind: 'person',
    owner_ref: 'user:owner',
    scope: 'personal',
    target: 'synthetic',
    auth_mode: 'secret-guard',
    secret_refs: ['SLACK_TOKEN'],
    allowed_actions: [selected.action],
    approval_policy: { [selected.action]: 'allowed' },
  };
  const generation = '12345678-1234-4123-8123-123456789abc';
  const scope = {
    runtime_use: 'selected-read-api-v1' as const,
    owner_ref: claim.ownerId,
    nhi_id: claim.actorId,
    binding_id: selected.bindingId,
    service_id: selected.serviceId,
    target: 'synthetic',
    secret_refs: ['SLACK_TOKEN'],
    allowed_actions: [selected.action],
    generation,
    project_id: 'project-a',
    mission_id: 'MSN-A',
    task_id: 'task-a',
  };
  const at = new Date(Date.now() - 1000).toISOString();
  mocks.grant = {
    schema_version: 'grant-record.v1',
    grant_id: selected.grantId,
    capability: 'credential.personal_use',
    custody: { kind: 'person', ref: 'owner' },
    scope,
    purpose: 'synthetic read',
    granted_by: { actor_id: 'user:owner', role: 'member_self', assurance: 'A2' },
    granted_at: at,
    expires_at: new Date(Date.parse(at) + 86400_000).toISOString(),
    audit_event_id: 'audit',
    basis: { approval_request_id: 'approval', approval_channel: 'grant-standing' },
  };
  const draft = { scope, purpose: 'synthetic read', ttl_days: 1 };
  const payloadHash = computeApprovalPayloadHash(personalCredentialGrantPayload(draft));
  const effectBinding = personalCredentialGrantEffect(draft);
  mocks.approval = {
    id: 'approval',
    channel: 'grant-standing',
    status: 'approved',
    scope: { tier: 'personal', nhi_id: claim.actorId },
    requestedByContext: { actorId: claim.actorId },
    accountability: { finalDecision: 'human_only', payloadHash, effectBinding },
    consumption: { consumer: 'grant_standing', effectRef: selected.grantId, consumedAt: at },
    workflow: {
      approvals: [
        {
          role: 'owner',
          status: 'approved',
          decidedByType: 'human',
          authenticated: true,
          approvedBy: 'user:owner',
          authMethod: 'surface_session',
          payloadHash,
          effectBinding,
        },
      ],
    },
  };
  mocks.endpoint = {
    base_url: 'https://example.invalid',
    credential_suffixes: { accessToken: ['TOKEN'] },
  };
  mocks.preset = {
    service_id: 'slack',
    auth_strategy: 'Bearer',
    operations: {
      [selected.action]: {
        type: 'api',
        method: 'GET',
        path: 'read',
        risk: 'read',
        approval_required: false,
      },
    },
  };
  mocks.registration = { generation };
  mocks.material = { SLACK_TOKEN: 'synthetic-only-token' };
}
describe('selected personal credential broker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });
  it('issues only a callback-live opaque selection and preserves the worker envelope', async () => {
    const envelope = mocks.envelope;
    let saved: object = {};
    await withPersonalServiceCredentialUse(selected, async (capability) => {
      saved = capability;
      const admitted = resolvePersonalServiceCredentialAdmission(
        capability,
        'slack',
        selected.action
      );
      expect(admitted).toMatchObject({
        ...selected,
        ownerRef: 'user:owner',
        projectId: 'project-a',
      });
      expect(admitted).not.toHaveProperty('secrets');
      expect(mocks.envelope).toBe(envelope);
      expect(mocks.overlay.secrets).toEqual({ SLACK_TOKEN: 'synthetic-only-token' });
      admitted.binding.target = 'forged';
      expect(resolvePersonalServiceCredentialAdmission(capability).binding.target).toBe(
        'synthetic'
      );
      expect(() =>
        resolvePersonalServiceCredentialAdmission({}, 'slack', selected.action)
      ).toThrow();
      expect(() => resolvePersonalServiceCredentialAdmission(capability, 'github')).toThrow();
    });
    expect(() => resolvePersonalServiceCredentialAdmission(saved)).toThrow();
  });
  it.each([
    'approval',
    'grant',
    'generation',
    'pending',
    'binding',
    'catalog',
    'lease',
    'scope',
    'material',
  ])('revalidates %s before subsequent consumption', async (change) => {
    await withPersonalServiceCredentialUse(selected, async (capability) => {
      if (change === 'approval') mocks.approval.revocation = {};
      if (change === 'grant')
        mocks.grant.revoked = {
          at: new Date().toISOString(),
          by: 'user:owner',
          audit_event_id: 'revocation',
        };
      if (change === 'generation')
        mocks.registration.generation = 'aaaaaaaa-1234-4123-8123-123456789abc';
      if (change === 'pending') mocks.registration.pendingApprovalId = 'pending';
      if (change === 'binding') mocks.binding.target = 'changed';
      if (change === 'catalog') mocks.endpoint.base_url = 'https://changed.invalid';
      if (change === 'lease')
        mocks.claim.mockImplementation(() => {
          throw new Error('expired');
        });
      if (change === 'scope') mocks.envelope = structuredClone(mocks.envelope);
      if (change === 'material') mocks.material = { SLACK_TOKEN: 'tampered' };
      expect(() => resolvePersonalServiceCredentialAdmission(capability)).toThrow();
      expect(() => mocks.overlay.validate()).toThrow();
    });
  });
  it.each([
    'owner',
    'task',
    'action',
    'post',
    'session',
    'fallback',
    'unconsumed',
    'query-auth',
    'placeholder',
    'dotsegment',
    'spoofed-resolver',
    'no-resolver',
    'legacy-consent',
  ])('denies %s before material is read', async (change) => {
    if (change === 'owner') mocks.grant.scope.owner_ref = 'user:other';
    if (change === 'task') mocks.grant.scope.task_id = 'other-task';
    if (change === 'action') mocks.binding.approval_policy[selected.action] = 'approval_required';
    if (change === 'post') mocks.preset.operations[selected.action].method = 'POST';
    if (change === 'session') mocks.binding.auth_mode = 'session';
    if (change === 'fallback')
      mocks.preset.operations[selected.action].alternatives = [{ type: 'cli' }];
    if (change === 'unconsumed') delete mocks.approval.consumption;
    if (change === 'query-auth') mocks.preset.auth_strategy = 'api_key_query';
    if (change === 'placeholder') mocks.preset.operations[selected.action].path = '{{target}}';
    if (change === 'dotsegment')
      mocks.preset.operations[selected.action].path = 'allowed/../elsewhere';
    if (change === 'spoofed-resolver') mocks.resolver = { name: 'local-credential-allocations' };
    if (change === 'no-resolver') mocks.resolver = null;
    if (change === 'legacy-consent') delete mocks.grant.scope.runtime_use;
    await expect(
      withPersonalServiceCredentialUse(selected, async () => 'unreachable')
    ).rejects.toThrow();
    expect(mocks.loadMaterial).not.toHaveBeenCalled();
  });
});
