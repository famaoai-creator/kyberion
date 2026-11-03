import { isDeepStrictEqual } from 'node:util';
import {
  getWorkItem,
  updateWorkItem,
  listActiveWorkLeases,
} from '../workforce/work-coordination.js';
import type {
  WorkItem,
  WorkLease,
  UpdateWorkItemInput,
} from '../workforce/work-coordination-types.js';
import { latestDotActions } from '../dot/dot-action-ledger.js';
import { safeReadFile } from '../secure-io.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import { loadInformationIntakeRecipes, informationAssetWorkKey } from './recipes.js';
import { prepareInformationAssetWork } from './work-preparation.js';
import { informationArtifactHash, verifyInformationAssetReadback } from './completion.js';
import {
  parseInformationAssetWorkBinding,
  type InformationAssetWorkBinding,
  type InformationAssetWorkInput,
  type InformationAssetWorkOutcome,
  type PreparedInformationWork,
  type InformationIntakeRecipe,
  type InformationAssetReadback,
} from './work-types.js';
import type { InformationAssetObservation } from './types.js';
export interface InformationAssetWorkDeps {
  rootDir?: string;
  tier: 'confidential' | 'personal';
  loadObservation(
    binding: InformationAssetWorkBinding
  ): Promise<InformationAssetObservation> | InformationAssetObservation;
  prepare?(
    recipe: InformationIntakeRecipe,
    observation: InformationAssetObservation
  ): Promise<PreparedInformationWork>;
  /** Must invoke the ordinary service actuator approval/effect gates, with work_key idempotency. */
  hostApply?(
    recipe: InformationIntakeRecipe,
    binding: InformationAssetWorkBinding,
    prepared: Extract<PreparedInformationWork, { kind: 'service_action' }>
  ): Promise<{
    status: 'applied' | 'approval_required' | 'unknown';
    approval_request_id?: string;
    execution_receipt_id?: string;
  }>;
  readback?(
    recipe: InformationIntakeRecipe,
    binding: InformationAssetWorkBinding
  ): Promise<InformationAssetReadback>;
  getItem?(id: string): WorkItem | null;
  updateItem?(input: UpdateWorkItemInput): WorkItem;
  getLease?(id: string): WorkLease | undefined;
  admittedBinding?(item: WorkItem): InformationAssetWorkBinding | undefined;
  writeArtifact?(binding: InformationAssetWorkBinding, text: string): Promise<string> | string;
  readArtifact?(ref: string): Promise<string> | string;
  recipes?: InformationIntakeRecipe[];
  now?: () => Date;
}
/** No work/approval store here: checkpoints live on the existing claimed WorkItem. */
export async function executeInformationAssetWork(
  input: InformationAssetWorkInput,
  deps: InformationAssetWorkDeps
): Promise<InformationAssetWorkOutcome> {
  const get = () => (deps.getItem ?? ((id: string) => getWorkItem(id, deps)))(input.workItemId);
  let original: InformationAssetWorkBinding | undefined;
  const fence = (): WorkItem => {
    const item = get();
    const lease = deps.getLease
      ? deps.getLease(input.leaseId)
      : listActiveWorkLeases().find((l) => l.lease_id === input.leaseId);
    if (
      !item ||
      item.status !== 'in_progress' ||
      item.lease_id !== input.leaseId ||
      item.current_attempt_id !== input.attemptId ||
      item.claimed_by_peer_id !== input.actorId ||
      item.metadata?.dot_id !== input.dotId ||
      !lease ||
      lease.status !== 'active' ||
      lease.item_id !== item.item_id ||
      lease.holder_peer_id !== input.actorId ||
      Date.parse(lease.expires_at) <= (deps.now?.() ?? new Date()).getTime()
    )
      throw new Error('[INFORMATION_WORK_FENCE] Current claim is required');
    const binding = parseInformationAssetWorkBinding(item.metadata?.information_asset_work);
    const admitted = deps.admittedBinding
      ? deps.admittedBinding(item)
      : latestDotActions({ rootDir: deps.rootDir, dotId: input.dotId }).find(
          (a) => a.action_ref === item.metadata?.action_ref && a.work_item_id === item.item_id
        )?.information_asset_work;
    if (
      !admitted ||
      !isDeepStrictEqual(binding, parseInformationAssetWorkBinding(admitted)) ||
      (original && !isDeepStrictEqual(original, binding))
    )
      throw new Error('[INFORMATION_WORK_ADMISSION] Immutable Dot admission binding required');
    const scope = binding.observation.scope;
    if (
      item.context?.tenant_slug !== scope.tenant_slug ||
      item.context.organization_id !== scope.organization_id ||
      (item.context.project_id ?? 'default') !== (scope.project_id ?? 'default')
    )
      throw new Error('[INFORMATION_WORK_SCOPE] WorkItem context differs from source');
    original = binding;
    return item;
  };
  let item = fence();
  const binding = original!;
  const recipe = (deps.recipes ?? loadInformationIntakeRecipes(deps)).find(
    (r) => r.recipe_id === binding.recipe_id && r.version === binding.recipe_version
  );
  if (!recipe) throw new Error('[INFORMATION_WORK_RECIPE] Recipe version unavailable');
  const observation = await deps.loadObservation(binding);
  fence();
  const {
    data: _data,
    source_url: _url,
    occurred_at: _occurred,
    observed_at: _observed,
    ...reference
  } = observation;
  if (
    !isDeepStrictEqual(reference, binding.observation) ||
    informationAssetWorkKey(observation, recipe) !== binding.work_key
  )
    throw new Error('[INFORMATION_WORK_SOURCE] Archived observation does not match admission');
  const prior = item.metadata?.information_asset_outcome as InformationAssetWorkOutcome | undefined;
  const save = (outcome: InformationAssetWorkOutcome): InformationAssetWorkOutcome => {
    item = fence();
    (deps.updateItem ?? updateWorkItem)({
      itemId: item.item_id,
      expectedVersion: item.version,
      metadata: { ...item.metadata, information_asset_outcome: outcome },
      rootDir: deps.rootDir,
    });
    return outcome;
  };
  const result = (
    status: InformationAssetWorkOutcome['status'],
    summary: string
  ): InformationAssetWorkOutcome => ({
    status,
    work_item_id: item.item_id,
    work_key: binding.work_key,
    summary,
  });
  const verify = async (): Promise<InformationAssetWorkOutcome | undefined> => {
    if (!deps.readback) return undefined;
    const evidence = await deps.readback(recipe, binding);
    fence();
    return verifyInformationAssetReadback(binding, evidence)
      ? save({
          ...result('completed', 'External state verified by readback'),
          evidence_sha256: evidence.evidence_sha256,
          ...((item.metadata?.information_asset_outcome as InformationAssetWorkOutcome | undefined)
            ?.execution_receipt_id
            ? {
                execution_receipt_id: (
                  item.metadata?.information_asset_outcome as InformationAssetWorkOutcome
                ).execution_receipt_id,
              }
            : {}),
        })
      : undefined;
  };
  if (
    prior?.work_key === binding.work_key &&
    ['unknown_effect', 'needs_recheck'].includes(prior.status)
  )
    return (
      (await verify()) ??
      save({
        ...prior,
        status: 'unknown_effect',
        summary:
          'Prior external effect is unresolved; inspect receipt and read back before retrying',
      })
    );
  if (prior?.status === 'completed' && prior.work_key === binding.work_key) {
    if (prior.artifact_ref && prior.evidence_sha256) {
      const content = await (
        deps.readArtifact ?? ((ref: string) => safeReadFile(ref, { encoding: 'utf8' }) as string)
      )(prior.artifact_ref);
      if (informationArtifactHash(content) === prior.evidence_sha256) return save(prior);
      throw new Error('[INFORMATION_WORK_ARTIFACT] Completed artifact hash no longer matches');
    }
    const verified = await verify();
    if (verified) return verified;
    return save(result('needs_recheck', 'Completed external state must be verified again'));
  }
  const prepared = await (
    deps.prepare ?? ((r, o) => prepareInformationAssetWork(r, o, { tier: deps.tier }))
  )(recipe, observation);
  fence();
  if (prepared.kind === 'waiting')
    return save({
      ...result('waiting_counterpart', prepared.reason),
      ...(prepared.recheck_at ? { recheck_at: prepared.recheck_at } : {}),
      ...(prepared.deadline ? { deadline: prepared.deadline } : {}),
    });
  if (prepared.kind === 'artifact') {
    if (recipe.completion !== 'artifact_hash')
      throw new Error('[INFORMATION_WORK_PROOF] Recipe requires external state verification');
    const ref = await (
      deps.writeArtifact ??
      ((b: InformationAssetWorkBinding, text: string) =>
        writeScopedArtifact({
          scope: {
            tenant: b.observation.scope.tenant_slug,
            organization: b.observation.scope.organization_id,
            ...(b.observation.scope.project_id ? { project: b.observation.scope.project_id } : {}),
          },
          tier: deps.tier,
          artifact_class: 'report',
          name: 'information-intake/' + b.work_key + '.json',
          content: text,
          format: 'text',
        }).absolute_path)
    )(binding, prepared.text);
    fence();
    const read = await (
      deps.readArtifact ?? ((p: string) => safeReadFile(p, { encoding: 'utf8' }) as string)
    )(ref);
    if (informationArtifactHash(read) !== informationArtifactHash(prepared.text))
      throw new Error('[INFORMATION_WORK_PROOF] Artifact readback differs');
    return save({
      ...result('completed', 'Artifact persisted and hash verified'),
      artifact_ref: ref,
      evidence_sha256: informationArtifactHash(read),
    });
  }
  if (recipe.completion !== 'external_readback')
    throw new Error('[INFORMATION_WORK_PROOF] Read-only recipe cannot perform external actions');
  if (typeof prepared.params.body === 'string') {
    item = fence();
    (deps.updateItem ?? updateWorkItem)({
      itemId: item.item_id,
      expectedVersion: item.version,
      metadata: {
        ...item.metadata,
        information_asset_expected_body_sha256: informationArtifactHash(prepared.params.body),
      },
      rootDir: deps.rootDir,
    });
  }
  if (!deps.hostApply)
    return save(result('waiting_approval', 'Governed service actuator authorization is required'));
  // Durable uncertain checkpoint precedes the effect. A crash never blindly replays a write.
  save(
    result('unknown_effect', 'External operation started; completion pending independent readback')
  );
  let applied: Awaited<ReturnType<NonNullable<InformationAssetWorkDeps['hostApply']>>>;
  try {
    fence();
    applied = await deps.hostApply(recipe, binding, prepared);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'adfControlFlow' in error &&
      error.adfControlFlow === 'suspend'
    ) {
      const suspended = error as { suspension?: { approval_request_id?: string } };
      save({
        ...result('waiting_approval', 'External operation suspended before effect'),
        approval_request_id: suspended.suspension?.approval_request_id,
      });
      throw error;
    }
    return save(result('unknown_effect', 'External operation outcome unknown; readback required'));
  }
  fence();
  if (applied.status === 'approval_required')
    return save({
      ...result('waiting_approval', 'External operation awaits existing service approval'),
      approval_request_id: applied.approval_request_id,
      execution_receipt_id: applied.execution_receipt_id,
    });
  const receipt = {
    ...result('unknown_effect', 'External operation needs independent readback'),
    execution_receipt_id: applied.execution_receipt_id,
  };
  save(receipt);
  return (await verify()) ?? receipt;
}
