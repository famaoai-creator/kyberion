import { describe, it, expect, vi } from 'vitest';
import {
  loadInformationIntakeRecipes,
  buildInformationAssetRecipeProposals,
  informationAssetWorkKey,
  INFORMATION_ASSET_WORK_PIPELINE,
} from './recipes.js';
import { executeInformationAssetWork, type InformationAssetWorkDeps } from './work-execution.js';
import {
  parseInformationAssetWorkBinding,
  buildInformationAssetMissionExecutionPlan,
  type InformationAssetWorkBinding,
} from './work-types.js';
import { prepareInformationAssetWork } from './work-preparation.js';
import { informationArtifactHash } from './completion.js';
import type { InformationAssetObservation } from './types.js';
import type { DotCharter } from '../dot/dot-charter.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
const scope = { tenant_slug: 'acme', organization_id: 'support' };
const obs: InformationAssetObservation = {
  event_id: 'e'.repeat(64),
  scope,
  asset_type: 'customer.request',
  location_id: 'mail',
  binding_id: 'mail-binding',
  service_id: 'google-workspace',
  subject_id: 'm1',
  change_id: 'rev1',
  event_type: 'message.observed',
  observed_at: '2026-11-02T00:00:00Z',
  content_sha256: 'a'.repeat(64),
  data: { subject: 'Help', snippet: 'Please respond' },
};
const recipes = loadInformationIntakeRecipes();
const charter = {
  dot_id: 'support-dot',
  scope: { ...scope, tier: 'confidential' },
  authority: {
    allowed_pipelines: [INFORMATION_ASSET_WORK_PIPELINE],
    allowed_execution_shapes: ['pipeline', 'mission'],
    mission_mandate_refs: ['fixture-mandate'],
  },
} as DotCharter;
function setup(recipeId = 'email.morning_triage') {
  const recipe = recipes.find((r) => r.recipe_id === recipeId)!;
  const observation = { ...obs, asset_type: recipe.asset_type, event_type: recipe.event_types[0] };
  const proposal = buildInformationAssetRecipeProposals(observation, charter, {
    recipes,
    recipeIds: [recipeId],
    missionAdmission: {
      mandate_ref: 'fixture-mandate',
      mandate_facts: {
        work_type: 'fixture',
        paths: ['active/'],
        estimated_cost: 0,
        currency: 'USD',
        external_effects: [],
        risk_level: 3,
      },
    },
  })[0];
  const binding = proposal.information_asset_work!;
  let item = {
    item_id: 'w1',
    status: 'in_progress',
    version: 1,
    lease_id: 'l1',
    current_attempt_id: 'a1',
    claimed_by_peer_id: 'dot:support-dot',
    context: { ...scope, work_shape: 'routine_operation' },
    metadata: { dot_id: 'support-dot', information_asset_work: binding },
  } as WorkItem;
  const artifacts = new Map<string, string>();
  const hostApply = vi.fn(async () => ({
    status: 'applied' as const,
    execution_receipt_id: 'receipt1',
  }));
  const deps: InformationAssetWorkDeps = {
    tier: 'confidential',
    recipes,
    loadObservation: () => observation,
    getItem: () => item,
    updateItem: (input) => {
      if (input.expectedVersion !== item.version) throw new Error('cas');
      item = { ...item, version: item.version + 1, metadata: input.metadata };
      return item;
    },
    getLease: () => ({
      lease_id: 'l1',
      item_id: 'w1',
      holder_peer_id: 'dot:support-dot',
      purpose: 'test',
      status: 'active',
      expires_at: '2099-01-01T00:00:00Z',
      created_at: '2026-01-01',
      renewed_at: '2026-01-01',
    }),
    admittedBinding: () => binding,
    prepare: async () =>
      recipe.completion === 'artifact_hash'
        ? { kind: 'artifact', text: 'verified artifact' }
        : { kind: 'service_action', params: { subject_id: observation.subject_id } },
    hostApply,
    readback: async () => ({
      scope,
      subject_id: observation.subject_id,
      change_id: observation.change_id,
      verified: true,
      evidence_sha256: 'b'.repeat(64),
    }),
    writeArtifact: (b, text) => {
      artifacts.set(b.work_key, text);
      return b.work_key;
    },
    readArtifact: (ref) => artifacts.get(ref) ?? '',
  };
  const input = {
    workItemId: 'w1',
    attemptId: 'a1',
    leaseId: 'l1',
    dotId: 'support-dot',
    actorId: 'dot:support-dot',
  };
  return {
    recipe,
    observation,
    binding,
    input,
    deps,
    hostApply,
    item: () => item,
    setItem: (next: WorkItem) => {
      item = next;
    },
  };
}
describe('information intake work', () => {
  it('declares twelve recipes and stable business identities across delivery ids', () => {
    expect(recipes).toHaveLength(12);
    const recipe = recipes[0];
    expect(informationAssetWorkKey(obs, recipe)).toBe(
      informationAssetWorkKey(
        { ...obs, event_id: 'f'.repeat(64), observed_at: '2030-01-01' },
        recipe
      )
    );
    expect(informationAssetWorkKey(obs, recipe)).not.toBe(
      informationAssetWorkKey({ ...obs, change_id: 'rev2' }, recipe)
    );
    expect(informationAssetWorkKey(obs, recipe)).not.toBe(
      informationAssetWorkKey(obs, { ...recipe, version: 2 })
    );
  });
  it('rejects cross-scope proposals and undeclared pipeline', () => {
    expect(() =>
      buildInformationAssetRecipeProposals(
        { ...obs, scope: { ...scope, tenant_slug: 'other' } },
        charter
      )
    ).toThrow('SCOPE');
    expect(() =>
      buildInformationAssetRecipeProposals(obs, {
        ...charter,
        authority: { ...charter.authority, allowed_pipelines: [] },
      })
    ).toThrow('PIPELINE');
  });
  it('strictly parses trusted bindings', () => {
    const f = setup();
    expect(parseInformationAssetWorkBinding(f.binding)).toEqual(f.binding);
    expect(() => parseInformationAssetWorkBinding({ ...f.binding, pipeline_ref: 'evil' })).toThrow(
      'BINDING'
    );
  });
  it('completes only after artifact readback and does not call external apply', async () => {
    const f = setup();
    const outcome = await executeInformationAssetWork(f.input, f.deps);
    expect(outcome.status).toBe('completed');
    expect(outcome.evidence_sha256).toBe(informationArtifactHash('verified artifact'));
    expect(f.hostApply).not.toHaveBeenCalled();
  });
  it('rejects wrong attempt and immutable admission changes', async () => {
    const f = setup();
    await expect(
      executeInformationAssetWork({ ...f.input, attemptId: 'old' }, f.deps)
    ).rejects.toThrow('FENCE');
    f.deps.admittedBinding = () => ({ ...f.binding, recipe_version: 999 });
    await expect(executeInformationAssetWork(f.input, f.deps)).rejects.toThrow('ADMISSION');
  });
  it('rejects revoked lease while preparing', async () => {
    const f = setup();
    f.deps.prepare = async () => {
      f.setItem({ ...f.item(), lease_id: 'other' });
      return { kind: 'artifact', text: 'x' };
    };
    await expect(executeInformationAssetWork(f.input, f.deps)).rejects.toThrow('FENCE');
  });
  it('requires independent exact-subject readback after write', async () => {
    const f = setup('jira.approval_pending');
    const outcome = await executeInformationAssetWork(f.input, f.deps);
    expect(outcome.status).toBe('completed');
    expect(f.hostApply).toHaveBeenCalledTimes(1);
    const g = setup('jira.approval_pending');
    g.deps.readback = async () => ({
      scope,
      subject_id: 'other',
      change_id: g.observation.change_id,
      verified: true,
      evidence_sha256: 'b'.repeat(64),
    });
    expect((await executeInformationAssetWork(g.input, g.deps)).status).toBe('unknown_effect');
  });
  it('never replays an unknown side effect, and can resolve it using readback', async () => {
    const f = setup('jira.approval_pending');
    f.hostApply.mockImplementation(async () => {
      throw new Error('connection dropped');
    });
    expect((await executeInformationAssetWork(f.input, f.deps)).status).toBe('unknown_effect');
    f.deps.readback = async () => ({
      scope,
      subject_id: f.observation.subject_id,
      change_id: f.observation.change_id,
      verified: false,
      evidence_sha256: 'b'.repeat(64),
    });
    expect((await executeInformationAssetWork(f.input, f.deps)).status).toBe('unknown_effect');
    expect(f.hostApply).toHaveBeenCalledTimes(1);
    f.deps.readback = async () => ({
      scope,
      subject_id: f.observation.subject_id,
      change_id: f.observation.change_id,
      verified: true,
      evidence_sha256: 'b'.repeat(64),
    });
    expect((await executeInformationAssetWork(f.input, f.deps)).status).toBe('completed');
    expect(f.hostApply).toHaveBeenCalledTimes(1);
  });
  it('holds approvals and counterpart waits on the same WorkItem', async () => {
    const f = setup('jira.approval_pending');
    f.deps.hostApply = async () => ({
      status: 'approval_required',
      approval_request_id: 'approval1',
    });
    const outcome = await executeInformationAssetWork(f.input, f.deps);
    expect(outcome).toMatchObject({ status: 'waiting_approval', approval_request_id: 'approval1' });
    expect(f.item().metadata?.information_asset_outcome).toEqual(outcome);
    const g = setup();
    g.deps.prepare = async () => ({
      kind: 'waiting',
      reason: 'Waiting on customer',
      recheck_at: '2026-11-03',
      deadline: '2026-11-05',
    });
    expect(await executeInformationAssetWork(g.input, g.deps)).toMatchObject({
      status: 'waiting_counterpart',
      recheck_at: '2026-11-03',
      deadline: '2026-11-05',
    });
  });
  it('bounds reasoning output and frames source instructions as untrusted', async () => {
    let prompt = '';
    const backend = {
      delegateTask: async (text: string) => {
        prompt = text;
        return JSON.stringify({
          summary: 'Respond',
          category: 'action_required',
          reply_draft: 'Thank you',
          actions: [{ title: 'Respond', owner: null, due_at: null }],
        });
      },
    };
    const prepared = await prepareInformationAssetWork(recipes[0], obs, {
      tier: 'confidential',
      backend,
    });
    expect(prepared.kind).toBe('artifact');
    expect(prompt).toContain('<untrusted_data');
    await expect(
      prepareInformationAssetWork(recipes[0], obs, {
        tier: 'confidential',
        backend: {
          delegateTask: async () =>
            JSON.stringify({
              summary: 'x',
              category: 'information',
              reply_draft: '',
              actions: [],
              pipeline_ref: 'evil',
            }),
        },
      })
    ).rejects.toThrow('semantic');
  });
  it('preserves an existing pipeline suspension and resumes approved pre-effect work', async () => {
    const f = setup('jira.approval_pending');
    const suspended = {
      adfControlFlow: 'suspend',
      suspension: { approval_request_id: 'approval-existing' },
    };
    f.hostApply.mockImplementationOnce(async () => {
      throw suspended;
    });
    await expect(executeInformationAssetWork(f.input, f.deps)).rejects.toBe(suspended);
    expect(f.item().metadata?.information_asset_outcome).toMatchObject({
      status: 'waiting_approval',
      approval_request_id: 'approval-existing',
    });
    expect((await executeInformationAssetWork(f.input, f.deps)).status).toBe('completed');
    expect(f.hostApply).toHaveBeenCalledTimes(2);
  });
  it('promotes external work through mission admission and binds the owner plan to that mission', () => {
    const f = setup('jira.approval_pending');
    const admission = {
      mandate_ref: 'fixture-mandate',
      mandate_facts: {
        work_type: 'fixture',
        paths: ['active/'],
        estimated_cost: 0,
        currency: 'USD',
        external_effects: ['jira:answer_request_approval'],
        risk_level: 3,
      },
    };
    const proposal = buildInformationAssetRecipeProposals(f.observation, charter, {
      recipes,
      recipeIds: ['jira.approval_pending'],
      missionAdmission: admission,
    })[0];
    expect(proposal.execution_shape).toBe('mission');
    expect(proposal.mission_admission).toEqual(admission);
    const item = {
      ...f.item(),
      metadata: {
        ...f.item().metadata,
        requested_work_shape: 'mission',
        mission_id: 'MSN-ADMITTED',
        mission_admission: admission,
      },
    };
    expect(buildInformationAssetMissionExecutionPlan(item, 'MSN-ADMITTED')).toMatchObject({
      mission_id: 'MSN-ADMITTED',
      work_item_id: 'w1',
      recipe_id: 'jira.approval_pending',
      pipeline_ref: INFORMATION_ASSET_WORK_PIPELINE,
    });
    expect(() => buildInformationAssetMissionExecutionPlan(item, 'MSN-OTHER')).toThrow('BINDING');
    expect(() =>
      buildInformationAssetRecipeProposals(
        f.observation,
        { ...charter, authority: { ...charter.authority, mission_mandate_refs: [] } },
        { recipes, recipeIds: ['jira.approval_pending'], missionAdmission: admission }
      )
    ).toThrow('MANDATE');
  });
});
