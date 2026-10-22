/**
 * Tenant information-asset ledger records for the promotion commands
 * (`scratch:promote --tenant`, `pipeline:promote --tenant`). A tenant
 * promotion lands a durable asset under knowledge/confidential/<slug>/, so it
 * gets the same DA-05 ledger line an ingest commit gets
 * (`<tenant knowledge root>/_ledger/assets.jsonl`, libs/core/ingest-asset-ledger.ts).
 * Public promotions never call this module.
 *
 * Call plan + append inside the caller's tenant-bound `asset_promoter`
 * context; resolve the actor BEFORE entering it (the context rewrites
 * MISSION_ROLE / KYBERION_PERSONA).
 */
import { createHash } from 'node:crypto';
import { readConfiguredActorIdentity } from '@agent/core/identity-context-bridge';
import {
  appendAssetRecord,
  assetProvenanceRef,
  deriveAssetId,
  findAssetBySource,
  readAssetLedger,
  type IngestAssetRecord,
  type IngestLedgerPathOptions,
} from '@agent/core/ingest-asset-ledger';

/** source_system of a promoted scratch directory (source_id = its repo-relative path). */
export const SCRATCH_PROMOTE_SOURCE_SYSTEM = 'scratch';
/** source_system of a promoted ADF file (source_id = its repo-relative path). */
export const PIPELINE_PROMOTE_SOURCE_SYSTEM = 'adf';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Who promoted, resolved like the ingest commit's `ingested_by`
 * (KYBERION_PERSONA, else MISSION_ROLE). Throws when neither is set: a tenant
 * asset is never landed anonymously.
 */
export function resolvePromotionActor(tag: string): string {
  const identity = readConfiguredActorIdentity();
  const persona = String(identity.persona || '').trim();
  if (persona) return persona;
  const role = String(identity.role || '').trim();
  if (role) return role;
  throw new Error(
    `${tag} tenant promotion refused — no identity for the asset ledger's ingested_by | ` +
      'run with KYBERION_PERSONA or MISSION_ROLE set (no anonymous tenant assets) | evidence: env'
  );
}

export interface PromotionAssetInput {
  tenant: string;
  sourceSystem: string;
  sourceId: string;
  /** Repo-relative path of the hashed file (TOOL.json / pipeline JSON). */
  targetPath: string;
  /** sha256 of the exact bytes written to targetPath. */
  contentSha256: string;
  transformChain: string[];
  ingestedBy: string;
  now: string;
  /** Diagnostic prefix ([scratch:promote] / [promote]). */
  tag: string;
}

export interface PromotionAssetPlan {
  /** 'append' writes `record`; 'unchanged' means the latest record already has this content. */
  action: 'append' | 'unchanged';
  record: IngestAssetRecord;
  ref: string;
}

/** Latest record (highest version, last appended on ties) currently pointing at a target. */
function latestForTarget(
  tenant: string,
  targetPath: string,
  options: IngestLedgerPathOptions
): IngestAssetRecord | null {
  let latest: IngestAssetRecord | null = null;
  for (const record of readAssetLedger(tenant, options)) {
    if (record.target_path === targetPath) latest = record;
  }
  return latest;
}

/**
 * Decide the ledger line for a tenant promotion without writing anything.
 * - Same source, same target, same content hash, and that asset still holds
 *   the target → 'unchanged' (no duplicate line).
 * - Same source, same target, new content → version+1 with `supersedes`.
 * - New source onto a target another asset holds (--force from a new scratch
 *   dir) → version 1 of the new asset with `supersedes` naming that record.
 * - Same source already recorded for a different target → refused: asset ids
 *   derive from the source, so a second target would corrupt its version chain.
 */
export function planPromotionAsset(
  input: PromotionAssetInput,
  options: IngestLedgerPathOptions = {}
): PromotionAssetPlan {
  const prior = findAssetBySource(input.tenant, input.sourceSystem, input.sourceId, options);
  if (prior && prior.target_path !== input.targetPath) {
    throw new Error(
      `${input.tag} ledger conflict — ${input.sourceId} is already recorded as ${prior.target_path} (${assetProvenanceRef(prior)}) | ` +
        'promote it into that target with --force, or copy the files into a new scratch path first | ' +
        `evidence: ${input.targetPath}`
    );
  }
  const holder = latestForTarget(input.tenant, input.targetPath, options);
  if (
    prior &&
    prior.content_sha256 === input.contentSha256 &&
    holder?.asset_id === prior.asset_id
  ) {
    return { action: 'unchanged', record: prior, ref: assetProvenanceRef(prior) };
  }
  // The record this promotion replaces: whoever holds the target now.
  const replaced = holder ?? prior;
  const record: IngestAssetRecord = {
    asset_id: deriveAssetId(input.sourceSystem, input.sourceId),
    source_system: input.sourceSystem,
    source_id: input.sourceId,
    content_sha256: input.contentSha256,
    retrieved_at: input.now,
    ingested_at: input.now,
    ingested_by: input.ingestedBy,
    visible_to: [input.tenant],
    transform_chain: input.transformChain,
    target_path: input.targetPath,
    version: prior ? prior.version + 1 : 1,
    ...(replaced ? { supersedes: `${replaced.asset_id}@v${replaced.version}` } : {}),
    status: 'active',
  };
  return { action: 'append', record, ref: assetProvenanceRef(record) };
}

/** Append the planned record (no-op for 'unchanged'). */
export function commitPromotionAsset(
  tenant: string,
  plan: PromotionAssetPlan,
  options: IngestLedgerPathOptions = {}
): void {
  if (plan.action === 'append') appendAssetRecord(tenant, plan.record, options);
}

/** Ledger summary returned by the commands (and written to the scratch marker). */
export function promotionAssetSummary(plan: PromotionAssetPlan): {
  asset_id: string;
  version: number;
  ref: string;
  recorded: boolean;
  supersedes?: string;
} {
  return {
    asset_id: plan.record.asset_id,
    version: plan.record.version,
    ref: plan.ref,
    recorded: plan.action === 'append',
    ...(plan.action === 'append' && plan.record.supersedes
      ? { supersedes: plan.record.supersedes }
      : {}),
  };
}
