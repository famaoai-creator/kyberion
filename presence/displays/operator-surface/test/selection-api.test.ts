import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  state: vi.fn(),
  scope: vi.fn(),
  serverScope: vi.fn(),
  env: vi.fn(),
  context: vi.fn(),
  missionPreview: vi.fn(),
  missionSave: vi.fn(),
  reasoningGet: vi.fn(),
  reasoningPreview: vi.fn(),
  reasoningSave: vi.fn(),
}));
vi.mock('../src/lib/viewer-context', () => ({ resolveOperatorViewer: mocks.viewer }));
vi.mock('@agent/core/foundation', () => ({
  getRegisteredEnvText: mocks.env,
  readJsonObjectRequest: async (req: NextRequest) => ({ ok: true, body: await req.json() }),
}));
vi.mock('@agent/core/scope-context', () => ({ resolveScopeResolution: mocks.serverScope }));
vi.mock('@agent/core/mission/mission-state', () => ({ loadState: mocks.state }));
vi.mock('@agent/core/authority', () => ({ withExecutionContextAsync: mocks.context }));
vi.mock('@agent/core/mission/mission-lifecycle-service', () => ({
  resolveMissionTeamSelectionScope: mocks.scope,
  missionLifecycleService: {
    previewTeamSelection: mocks.missionPreview,
    saveTeamSelection: mocks.missionSave,
  },
}));
vi.mock('@agent/core/reasoning/reasoning-selection-settings', () => ({
  getReasoningSelectionSettings: mocks.reasoningGet,
  previewReasoningSelection: mocks.reasoningPreview,
  saveReasoningSelection: mocks.reasoningSave,
}));

import { SurfaceViewerScopeError } from '@agent/core/surface/surface-mutation-guard';
import { handleSelectionRequest } from '../src/lib/selection-route';
import { canViewSelectionMission } from '../src/lib/selection-access';
import type { OperatorViewer } from '../src/lib/viewer-context';
import type { MissionState } from '@agent/core/mission/mission-types';

const globalAdmin: OperatorViewer = {
  role: 'localadmin',
  principalId: 'registered-operator',
  source: 'token',
  credentialSource: 'session-cookie',
  loopback: false,
  tenantSlugs: 'all',
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['public', 'confidential'],
};
const mission = {
  mission_id: 'MSN-FIXTURE',
  tier: 'confidential',
  tenant_slug: 'acme',
  organization_id: 'org-acme',
  relationships: { project: { project_id: 'project-one' } },
} as MissionState;
const missionView = {
  preview_token: 'a'.repeat(64),
  mission_id: 'MSN-FIXTURE',
  revision: 'revision-one',
  roles: [
    {
      team_role: 'implementer',
      configured: { mode: 'auto' },
      effective: {
        agent_id: 'agent-one',
        provider: 'synthetic',
        model_id: 'fixture-model',
        status: 'standby',
      },
      source: 'auto',
      reason: 'Cached fixture',
      candidates: [],
    },
  ],
};
const reasoningView = {
  revision: 2,
  roles: [
    {
      role: 'planner',
      requested: { mode: 'auto' },
      effective: { runtime_mode: 'stub' },
      source: 'user',
      reason: 'Cached fixture',
      valid: true,
      fallback: false,
    },
  ],
  choices: [],
};
const command = {
  action: 'save',
  role: 'planner',
  selection: { mode: 'auto' },
  expectedRevision: '2',
};
function request(
  body: unknown = command,
  options: { origin?: string; method?: string; headers?: Record<string, string> } = {}
) {
  const method = options.method ?? 'POST';
  return new NextRequest('https://ops.example/api/reasoning/selection', {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.origin === '' ? {} : { origin: options.origin ?? 'https://ops.example' }),
      ...options.headers,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewer.mockReturnValue({ ...globalAdmin });
  mocks.env.mockReturnValue('');
  mocks.serverScope.mockReturnValue({ scope: { tier: 'public' }, provenance: { tier: 'default' } });
  mocks.state.mockReturnValue(mission);
  mocks.scope.mockImplementation((state: MissionState & { project_id?: string }) => {
    const organization =
      state.organization_id?.trim() || state.relationships?.organization?.organization_id?.trim();
    const project = state.project_id?.trim() || state.relationships?.project?.project_id?.trim();
    if (
      state.organization_id &&
      state.relationships?.organization?.organization_id &&
      state.organization_id.trim() !== state.relationships.organization.organization_id.trim()
    )
      throw new Error('Conflicting organization aliases');
    if (
      state.project_id &&
      state.relationships?.project?.project_id &&
      state.project_id.trim() !== state.relationships.project.project_id.trim()
    )
      throw new Error('Conflicting project aliases');
    return {
      tier: state.tier,
      tenant_slug: state.tenant_slug?.trim(),
      organization_id: organization,
      project_id: project,
    };
  });
  mocks.context.mockImplementation(async (_role, fn) => fn());
  mocks.missionPreview.mockReturnValue(missionView);
  mocks.missionSave.mockResolvedValue({ ...missionView, revision: 'revision-two' });
  mocks.reasoningGet.mockReturnValue(reasoningView);
  mocks.reasoningPreview.mockReturnValue(reasoningView.roles[0]);
  mocks.reasoningSave.mockReturnValue({ ...reasoningView, revision: 3 });
});

describe('selection authentication and scope boundary', () => {
  it('returns 401 without a verified viewer and performs no store work', async () => {
    mocks.viewer.mockImplementation(() => {
      throw new SurfaceViewerScopeError(401, 'no viewer');
    });
    expect((await handleSelectionRequest(request(), { kind: 'reasoning' })).status).toBe(401);
    expect(mocks.reasoningSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it.each([
    { role: 'readonly' },
    { source: 'loopback', credentialSource: 'none', loopback: true },
    { source: 'anonymous' },
    { principalId: undefined },
  ])('rejects readonly/unverified admin claims: %j', async (override) => {
    mocks.viewer.mockReturnValue({ ...globalAdmin, ...override });
    expect((await handleSelectionRequest(request(), { kind: 'reasoning' })).status).toBe(403);
    expect(mocks.reasoningSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it.each(['https://evil.example', 'null', ''])(
    'denies invalid/cross-origin/missing origin %s, even with bearer auth',
    async (origin) => {
      mocks.viewer.mockReturnValue({ ...globalAdmin, credentialSource: 'header' });
      expect(
        (await handleSelectionRequest(request(command, { origin }), { kind: 'reasoning' })).status
      ).toBe(403);
      expect(mocks.reasoningSave).not.toHaveBeenCalled();
      expect(mocks.context).not.toHaveBeenCalled();
    }
  );
  it.each([
    { tenantSlugs: ['acme'] },
    { organizationIds: ['org-acme'] },
    { projectIds: ['project-one'] },
    { tierAccess: ['public'] },
  ])('blocks scoped admin global-store writes: %j', async (scope) => {
    mocks.viewer.mockReturnValue({ ...globalAdmin, ...scope });
    expect((await handleSelectionRequest(request(), { kind: 'reasoning' })).status).toBe(403);
    expect(mocks.reasoningSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('blocks global-store writes from a server bound to one tenant', async () => {
    mocks.serverScope.mockReturnValue({
      scope: { tier: 'public', tenant_slug: 'acme' },
      provenance: { tier: 'default', tenant_slug: 'env' },
    });
    expect((await handleSelectionRequest(request(), { kind: 'reasoning' })).status).toBe(403);
  });
  it.each(['env', 'scope.env'])(
    'blocks global writes for explicit or persisted server scope: %s',
    async (provenance) => {
      for (const dimension of [
        'tenant_slug',
        'organization_id',
        'project_id',
        'mission_id',
        'task_id',
      ]) {
        mocks.serverScope.mockReturnValue({
          scope: { tier: 'public', [dimension]: 'bound' },
          provenance: { tier: 'default', [dimension]: provenance },
        });
        expect((await handleSelectionRequest(request(), { kind: 'reasoning' })).status).toBe(403);
      }
      mocks.serverScope.mockReturnValue({
        scope: { tier: 'public' },
        provenance: { tier: provenance },
      });
      expect((await handleSelectionRequest(request(), { kind: 'reasoning' })).status).toBe(403);
      expect(mocks.reasoningSave).not.toHaveBeenCalled();
      expect(mocks.context).not.toHaveBeenCalled();
      expect(mocks.serverScope).toHaveBeenCalledWith({}, process.env, { inferFromCwd: false });
    }
  );
  it('preserves unrestricted global admin writes and fails closed if server scope is invalid', async () => {
    expect((await handleSelectionRequest(request(), { kind: 'reasoning' })).status).toBe(200);
    mocks.serverScope.mockImplementation(() => {
      throw new Error('Invalid persisted scope');
    });
    expect((await handleSelectionRequest(request(), { kind: 'reasoning' })).status).toBe(403);
    expect(mocks.reasoningSave).toHaveBeenCalledOnce();
  });
  it('narrows mission access consistently to explicit and persisted server bindings', () => {
    mocks.serverScope.mockReturnValue({
      scope: {
        tier: 'confidential',
        tenant_slug: 'acme',
        organization_id: 'org-acme',
        project_id: 'project-one',
        mission_id: 'MSN-FIXTURE',
      },
      provenance: { tier: 'scope.env' },
    });
    expect(canViewSelectionMission(globalAdmin, mission)).toBe(true);
    for (const dimension of ['tenant_slug', 'organization_id', 'project_id', 'mission_id']) {
      mocks.serverScope.mockReturnValue({
        scope: { tier: 'public', [dimension]: 'foreign' },
        provenance: { tier: 'default', [dimension]: 'env' },
      });
      expect(canViewSelectionMission(globalAdmin, mission)).toBe(false);
    }
    mocks.serverScope.mockReturnValue({
      scope: { tier: 'public' },
      provenance: { tier: 'scope.env' },
    });
    expect(canViewSelectionMission(globalAdmin, mission)).toBe(false);
  });
  it('allows read-only snapshots without writable controls', async () => {
    mocks.viewer.mockReturnValue({ ...globalAdmin, role: 'readonly' });
    const response = await handleSelectionRequest(request(null, { method: 'GET' }), {
      kind: 'reasoning',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).canEdit).toBe(false);
    expect(mocks.reasoningSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('authorizes the canonical mission before entering the privileged context', async () => {
    mocks.viewer.mockReturnValue({ ...globalAdmin, tenantSlugs: ['another-tenant'] });
    const response = await handleSelectionRequest(
      request({
        ...command,
        role: 'implementer',
        expectedRevision: 'revision-one',
        expectedPreviewToken: 'a'.repeat(64),
      }),
      { kind: 'mission', missionId: 'MSN-FIXTURE' }
    );
    expect(response.status).toBe(403);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.missionSave).not.toHaveBeenCalled();
  });
  it('checks organization/project and refuses conflicting/missing bindings', () => {
    const viewer = {
      ...globalAdmin,
      tenantSlugs: ['acme'],
      organizationIds: ['org-acme'],
      projectIds: ['project-one'],
    } as OperatorViewer;
    expect(canViewSelectionMission(viewer, mission)).toBe(true);
    expect(canViewSelectionMission({ ...viewer, projectIds: ['other'] }, mission)).toBe(false);
    expect(canViewSelectionMission(viewer, { ...mission, relationships: undefined })).toBe(false);
    expect(
      canViewSelectionMission(viewer, {
        ...mission,
        relationships: { ...mission.relationships, organization: { organization_id: 'other' } },
      })
    ).toBe(false);
  });
  it('uses the shared canonical scope resolver for legacy aliases in authorization and writes', async () => {
    const aliased = {
      ...mission,
      organization_id: undefined,
      project_id: ' project-one ',
      relationships: {
        organization: { organization_id: ' org-acme ' },
        project: { relationship_type: 'belongs_to' },
      },
    } as unknown as MissionState;
    mocks.state.mockReturnValue(aliased);
    mocks.viewer.mockReturnValue({
      ...globalAdmin,
      tenantSlugs: ['acme'],
      organizationIds: ['org-acme'],
      projectIds: ['project-one'],
    });
    const response = await handleSelectionRequest(
      request({
        ...command,
        role: 'implementer',
        expectedRevision: 'revision-one',
        expectedPreviewToken: 'a'.repeat(64),
      }),
      { kind: 'mission', missionId: 'MSN-FIXTURE' }
    );
    expect(response.status).toBe(200);
    expect(mocks.scope).toHaveBeenCalledWith(aliased);
    expect(mocks.missionSave).toHaveBeenCalledWith(
      'MSN-FIXTURE',
      expect.objectContaining({
        expected_scope: {
          tier: 'confidential',
          tenant_slug: 'acme',
          organization_id: 'org-acme',
          project_id: 'project-one',
        },
      }),
      expect.anything()
    );
  });
  it('requires a preview decision token for mission save', async () => {
    const response = await handleSelectionRequest(
      request({ ...command, role: 'implementer', expectedRevision: 'revision-one' }),
      { kind: 'mission', missionId: 'MSN-FIXTURE' }
    );
    expect(response.status).toBe(400);
    expect(mocks.missionSave).not.toHaveBeenCalled();
  });

  it('passes only server-derived scope to the governed mission facade', async () => {
    const response = await handleSelectionRequest(
      request({
        ...command,
        role: 'implementer',
        expectedRevision: 'revision-one',
        expectedPreviewToken: 'a'.repeat(64),
      }),
      { kind: 'mission', missionId: 'MSN-FIXTURE' }
    );
    expect(response.status).toBe(200);
    expect(mocks.context).toHaveBeenCalledWith('mission_controller', expect.any(Function));
    expect(mocks.missionSave).toHaveBeenCalledWith(
      'MSN-FIXTURE',
      expect.objectContaining({
        expected_scope: {
          tier: 'confidential',
          tenant_slug: 'acme',
          organization_id: 'org-acme',
          project_id: 'project-one',
        },
        expected_revision: 'revision-one',
        expected_preview_token: 'a'.repeat(64),
      }),
      { surface: 'operator-surface', actorId: 'registered-operator' }
    );
  });
  it('rejects client scope/role/token authorization fields', async () => {
    expect(
      (
        await handleSelectionRequest(request({ ...command, tenant: 'acme', token: 'fake' }), {
          kind: 'reasoning',
        })
      ).status
    ).toBe(400);
    expect(mocks.reasoningSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
});

describe('selection preview and revision safety', () => {
  it('enters only the narrow settings writer for an authenticated unrestricted save', async () => {
    const response = await handleSelectionRequest(request(), { kind: 'reasoning' });
    expect(response.status).toBe(200);
    expect(mocks.context).toHaveBeenCalledOnce();
    expect(mocks.context).toHaveBeenCalledWith('reasoning_settings_writer', expect.any(Function));
    expect(mocks.reasoningSave).toHaveBeenCalledOnce();
    expect(mocks.reasoningSave).toHaveBeenCalledWith({
      role: 'planner',
      selection: { mode: 'auto' },
      expectedRevision: 2,
      actorId: 'registered-operator',
    });
  });
  it('rejects invalid or already-stale save input before any writer role entry', async () => {
    expect(
      (
        await handleSelectionRequest(request({ ...command, selection: { mode: 'fixed' } }), {
          kind: 'reasoning',
        })
      ).status
    ).toBe(400);
    expect(
      (
        await handleSelectionRequest(request({ ...command, expectedRevision: '1' }), {
          kind: 'reasoning',
        })
      ).status
    ).toBe(409);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.reasoningSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('preserves a stored target while exposing its current ineligibility separately', async () => {
    mocks.missionPreview.mockReturnValue({
      ...missionView,
      roles: [
        {
          ...missionView.roles[0],
          source: 'requested',
          reason: 'Stored fixed target.',
          configured: { mode: 'fixed', agent_id: 'agent-one' },
          eligibility: {
            eligible: false,
            reason: 'Cached provider is unavailable. Select an eligible agent before dispatch.',
          },
        },
      ],
    });
    const response = await handleSelectionRequest(request(null, { method: 'GET' }), {
      kind: 'mission',
      missionId: 'MSN-FIXTURE',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).rows[0]).toMatchObject({
      effective: { agent_id: 'agent-one', provider: 'synthetic', model: 'fixture-model' },
      source: 'requested',
      reason: 'Stored fixed target.',
      valid: false,
      eligibility: {
        eligible: false,
        reason: 'Cached provider is unavailable. Select an eligible agent before dispatch.',
      },
    });
    expect(mocks.missionSave).not.toHaveBeenCalled();
  });
  it('preview invokes no write or privileged context', async () => {
    const response = await handleSelectionRequest(request({ ...command, action: 'preview' }), {
      kind: 'reasoning',
    });
    expect(response.status).toBe(200);
    expect(mocks.reasoningPreview).toHaveBeenCalledOnce();
    expect(mocks.reasoningSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('mission preview invokes no write and detects stale cached evidence', async () => {
    const response = await handleSelectionRequest(
      request({
        ...command,
        action: 'preview',
        role: 'implementer',
        expectedRevision: 'old-revision',
      }),
      { kind: 'mission', missionId: 'MSN-FIXTURE' }
    );
    expect(response.status).toBe(409);
    expect(mocks.missionSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('stale reasoning preview refuses the save path', async () => {
    expect(
      (
        await handleSelectionRequest(
          request({ ...command, action: 'preview', expectedRevision: '1' }),
          { kind: 'reasoning' }
        )
      ).status
    ).toBe(409);
    expect(mocks.reasoningSave).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('maps locked CAS refusal to conflict without exposing internal error text', async () => {
    mocks.reasoningSave.mockImplementation(() => {
      throw Object.assign(new Error('private path and config'), {
        code: 'REASONING_SELECTION_REVISION_CONFLICT',
      });
    });
    const response = await handleSelectionRequest(request(), { kind: 'reasoning' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'STALE_SELECTION' });
  });
  it('maps mission stale scope and active ownership refusal from the governed facade', async () => {
    mocks.missionSave.mockRejectedValue(new Error('[MISSION_TEAM_SELECTION_STALE] private path'));
    expect(
      (
        await handleSelectionRequest(
          request({
            ...command,
            role: 'implementer',
            expectedRevision: 'revision-one',
            expectedPreviewToken: 'a'.repeat(64),
          }),
          { kind: 'mission', missionId: 'MSN-FIXTURE' }
        )
      ).status
    ).toBe(409);
    mocks.missionSave.mockRejectedValue(
      new Error('[MISSION_TEAM_SELECTION_ACTIVE] runtime active')
    );
    expect(
      (
        await handleSelectionRequest(
          request({
            ...command,
            role: 'implementer',
            expectedRevision: 'revision-one',
            expectedPreviewToken: 'a'.repeat(64),
          }),
          { kind: 'mission', missionId: 'MSN-FIXTURE' }
        )
      ).status
    ).toBe(422);
  });
});
