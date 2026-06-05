import AjvModule from 'ajv';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { findMissionPath, pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';

export type ArtifactBundleStatus = 'assembling' | 'pending_review' | 'approved' | 'rejected' | 'superseded';

export interface ArtifactBundleItem {
  artifact_id: string;
  kind: string;
  storage_class: 'repo' | 'artifact_store' | 'vault' | 'tmp' | 'external_ref';
  path?: string;
  external_ref?: string;
  fulfills_track_requirement?: string;
  fulfills_outcome_id?: string;
}

export interface ArtifactBundleApproval {
  status: 'pending' | 'approved' | 'rejected';
  reviewer?: string;
  reviewed_at?: string;
  note?: string;
}

export interface ArtifactBundle {
  bundle_id: string;
  project_id?: string;
  track_id?: string;
  track_name?: string;
  mission_id: string;
  status: ArtifactBundleStatus;
  items: ArtifactBundleItem[];
  fulfills_outcome_ids: string[];
  required_artifact_kinds: string[];
  approval: ArtifactBundleApproval;
  created_at: string;
  updated_at: string;
}

export interface ArtifactBundleFulfillmentReport {
  satisfied: string[];
  missing: string[];
  fulfilled: boolean;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const BUNDLE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/artifact-bundle.schema.json');
let bundleValidateFn: ReturnType<typeof compileSchemaFromPath> | null = null;

function ensureValidator() {
  if (bundleValidateFn) return bundleValidateFn;
  bundleValidateFn = compileSchemaFromPath(ajv, BUNDLE_SCHEMA_PATH);
  return bundleValidateFn;
}

function normalizeMissionDir(
  missionId: string,
  missionPath?: string,
  options: { createIfMissing?: boolean } = {},
): string | null {
  if (missionPath) {
    if (options.createIfMissing || safeExistsSync(missionPath)) return missionPath;
    return null;
  }
  const found = findMissionPath(missionId);
  if (found) return found;
  if (options.createIfMissing) return pathResolver.missionDir(missionId);
  return null;
}

function bundleDir(missionId: string, missionPath?: string, options: { createIfMissing?: boolean } = {}): string | null {
  const missionDir = normalizeMissionDir(missionId, missionPath, options);
  if (!missionDir) return null;
  return path.join(missionDir, 'coordination', 'artifact-bundles');
}

function validateConsistency(bundle: ArtifactBundle): string[] {
  const errors: string[] = [];
  if (bundle.status === 'approved' && bundle.approval.status !== 'approved') {
    errors.push('bundle.status=approved requires approval.status=approved');
  }
  if ((bundle.status === 'assembling' || bundle.status === 'pending_review' || bundle.status === 'superseded')
    && bundle.approval.status !== 'pending') {
    errors.push(`bundle.status=${bundle.status} requires approval.status=pending`);
  }
  if (bundle.status === 'rejected' && bundle.approval.status !== 'rejected') {
    errors.push('bundle.status=rejected requires approval.status=rejected');
  }
  return errors;
}

export function createArtifactBundle(input: {
  missionId: string;
  projectId?: string;
  trackId?: string;
  trackName?: string;
  fulfillsOutcomeIds?: string[];
  requiredArtifactKinds?: string[];
  items?: ArtifactBundleItem[];
}): ArtifactBundle {
  const now = new Date().toISOString();
  return {
    bundle_id: `BND-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    mission_id: input.missionId,
    project_id: input.projectId,
    track_id: input.trackId,
    track_name: input.trackName,
    status: 'assembling',
    items: input.items ?? [],
    fulfills_outcome_ids: input.fulfillsOutcomeIds ?? [],
    required_artifact_kinds: input.requiredArtifactKinds ?? [],
    approval: { status: 'pending' },
    created_at: now,
    updated_at: now,
  };
}

export function validateArtifactBundle(value: unknown): value is ArtifactBundle {
  const validate = ensureValidator();
  if (!validate(value)) return false;
  const bundle = value as ArtifactBundle;
  return validateConsistency(bundle).length === 0;
}

export function saveArtifactBundle(bundle: ArtifactBundle, missionPath?: string): string {
  if (!validateArtifactBundle(bundle)) {
    const schemaErrors = (ensureValidator().errors ?? []).map(
      (e) => `${e.instancePath || '/'} ${e.message ?? 'schema violation'}`,
    );
    const consistencyErrors = validateConsistency(bundle);
    throw new Error(`Invalid artifact bundle: ${[...schemaErrors, ...consistencyErrors].join('; ')}`);
  }
  const dir = bundleDir(bundle.mission_id, missionPath, { createIfMissing: true });
  if (!dir) {
    throw new Error(`Unable to resolve mission directory for artifact bundle ${bundle.bundle_id}.`);
  }
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${bundle.bundle_id}.json`);
  safeWriteFile(filePath, JSON.stringify({ ...bundle, updated_at: new Date().toISOString() }, null, 2));
  return filePath;
}

export function loadArtifactBundle(missionId: string, bundleId: string, missionPath?: string): ArtifactBundle | null {
  const dir = bundleDir(missionId, missionPath);
  if (!dir) return null;
  const filePath = path.join(dir, `${bundleId}.json`);
  if (!safeExistsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as ArtifactBundle;
    return validateArtifactBundle(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function listArtifactBundlesForMission(missionId: string, missionPath?: string): ArtifactBundle[] {
  const dir = bundleDir(missionId, missionPath);
  if (!dir || !safeExistsSync(dir)) return [];
  const bundles = safeReaddir(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadArtifactBundle(missionId, entry.replace(/\.json$/, ''), missionPath))
    .filter((bundle): bundle is ArtifactBundle => Boolean(bundle));
  return bundles
    .filter((bundle) => bundle.mission_id === missionId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function loadLatestArtifactBundleForMission(missionId: string, missionPath?: string): ArtifactBundle | null {
  const bundles = listArtifactBundlesForMission(missionId, missionPath);
  return bundles.length ? bundles[bundles.length - 1] : null;
}

export function addItemToArtifactBundle(bundle: ArtifactBundle, item: ArtifactBundleItem): ArtifactBundle {
  return {
    ...bundle,
    items: [...bundle.items.filter((i) => i.artifact_id !== item.artifact_id), item],
    updated_at: new Date().toISOString(),
  };
}

export function transitionBundleToReview(bundle: ArtifactBundle): ArtifactBundle {
  return { ...bundle, status: 'pending_review', updated_at: new Date().toISOString() };
}

export function applyBundleApproval(
  bundle: ArtifactBundle,
  decision: { verdict: 'approved' | 'rejected'; reviewer?: string; note?: string },
): ArtifactBundle {
  const now = new Date().toISOString();
  return {
    ...bundle,
    status: decision.verdict === 'approved' ? 'approved' : 'rejected',
    approval: {
      status: decision.verdict,
      reviewer: decision.reviewer,
      reviewed_at: now,
      note: decision.note,
    },
    updated_at: now,
  };
}

export function checkArtifactBundleFulfillment(bundle: ArtifactBundle): ArtifactBundleFulfillmentReport {
  const covered = new Set(bundle.items.map((item) => item.kind));
  const satisfied = bundle.required_artifact_kinds.filter((kind) => covered.has(kind));
  const missing = bundle.required_artifact_kinds.filter((kind) => !covered.has(kind));
  return { satisfied, missing, fulfilled: missing.length === 0 };
}

export function buildBundleFromOutcomeContract(input: {
  missionId: string;
  projectId?: string;
  trackId?: string;
  trackName?: string;
  outcomeContract: { outcome_id: string; expected_artifacts: Array<{ kind: string; storage_class: ArtifactBundleItem['storage_class'] }> };
  trackRequiredArtifactKinds?: string[];
}): ArtifactBundle {
  const fromOutcome = input.outcomeContract.expected_artifacts.map((artifact) => artifact.kind);
  const fromTrack = input.trackRequiredArtifactKinds ?? [];
  const requiredKinds = [...new Set([...fromOutcome, ...fromTrack])];
  return createArtifactBundle({
    missionId: input.missionId,
    projectId: input.projectId,
    trackId: input.trackId,
    trackName: input.trackName,
    fulfillsOutcomeIds: [input.outcomeContract.outcome_id],
    requiredArtifactKinds: requiredKinds,
  });
}
