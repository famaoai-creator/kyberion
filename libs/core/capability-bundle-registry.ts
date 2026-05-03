import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const CAPABILITY_BUNDLE_REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'public/schemas/capability-bundle-registry.schema.json'
);

export type CapabilityBundleStatus = 'active' | 'experimental' | 'conceptual' | 'deprecated';

export interface CapabilityBundleEntry {
  bundle_id: string;
  status: CapabilityBundleStatus;
  kind: 'actuator-pipeline-bundle' | 'capability-bundle';
  summary: string;
  source_bundle_path?: string;
  harness_capability_refs?: string[];
  intents?: string[];
  required_actuators?: string[];
  references?: string[];
}

export interface CapabilityBundleRegistryFile {
  version: string;
  bundles: CapabilityBundleEntry[];
}

let capabilityBundleRegistryCache: CapabilityBundleRegistryFile | null = null;
let capabilityBundleRegistryValidateFn: ValidateFunction | null = null;

function ensureCapabilityBundleRegistryValidator(): ValidateFunction {
  if (capabilityBundleRegistryValidateFn) return capabilityBundleRegistryValidateFn;
  capabilityBundleRegistryValidateFn = compileSchemaFromPath(
    ajv,
    CAPABILITY_BUNDLE_REGISTRY_SCHEMA_PATH
  );
  return capabilityBundleRegistryValidateFn;
}

export function loadCapabilityBundleRegistry(): CapabilityBundleRegistryFile {
  if (capabilityBundleRegistryCache) return capabilityBundleRegistryCache;
  const filePath = pathResolver.knowledge('public/governance/capability-bundle-registry.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as CapabilityBundleRegistryFile;
  const validate = ensureCapabilityBundleRegistryValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid capability-bundle-registry: ${errors}`);
  }
  capabilityBundleRegistryCache = parsed;
  return capabilityBundleRegistryCache;
}

function statusRank(status: CapabilityBundleStatus): number {
  switch (status) {
    case 'active':
      return 0;
    case 'experimental':
      return 1;
    case 'conceptual':
      return 2;
    case 'deprecated':
      return 3;
  }
}

export function resolveCapabilityBundleForIntent(
  intentId?: string
): CapabilityBundleEntry | null {
  if (!intentId) return null;
  const matched = loadCapabilityBundleRegistry().bundles
    .filter((bundle) => (bundle.intents || []).includes(intentId))
    .sort((left, right) => statusRank(left.status) - statusRank(right.status));
  return matched[0] || null;
}

export function summarizeRelevantCapabilityBundlesForIntentIds(
  intentIds: string[]
): string {
  const bundleById = new Map<string, CapabilityBundleEntry>();
  for (const intentId of intentIds) {
    const bundle = resolveCapabilityBundleForIntent(intentId);
    if (!bundle) continue;
    bundleById.set(bundle.bundle_id, bundle);
  }

  const bundles = [...bundleById.values()].map((bundle) => ({
    bundle_id: bundle.bundle_id,
    status: bundle.status,
    kind: bundle.kind,
    summary: bundle.summary,
    required_actuators: bundle.required_actuators || [],
    intents: bundle.intents || [],
    harness_capability_refs: bundle.harness_capability_refs || [],
    references: bundle.references || [],
  }));

  return JSON.stringify(bundles, null, 2);
}

export function summarizeRelevantCapabilityBundlesForIntentIdsCompact(
  intentIds: string[]
): string {
  const bundleById = new Map<string, CapabilityBundleEntry>();
  for (const intentId of intentIds) {
    const bundle = resolveCapabilityBundleForIntent(intentId);
    if (!bundle) continue;
    bundleById.set(bundle.bundle_id, bundle);
  }

  const bundles = [...bundleById.values()].sort((left, right) => {
    const statusCompare = statusRank(left.status) - statusRank(right.status);
    if (statusCompare !== 0) return statusCompare;
    return left.bundle_id.localeCompare(right.bundle_id);
  });

  if (bundles.length === 0) return 'none';

  return bundles
    .map((bundle) => {
      const intents = (bundle.intents || []).slice(0, 4).join(', ') || 'n/a';
      const actuators = (bundle.required_actuators || []).slice(0, 4).join(', ') || 'n/a';
      const harnessRefs = (bundle.harness_capability_refs || []).slice(0, 3).join(', ') || 'n/a';
      return `- ${bundle.bundle_id} [${bundle.status}] kind=${bundle.kind} intents=${intents} actuators=${actuators} harness=${harnessRefs}`;
    })
    .join('\n');
}
