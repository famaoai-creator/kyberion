import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { nowIso } from '../foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir, safeStat } from '../secure-io.js';
import { logger } from '../core.js';

export interface ActuatorManifestCapabilityRequirements {
  bin?: string[];
  lib?: string[];
  env?: string[];
  /** When set, `env` is required only on these platforms (e.g. Linux file-secret opt-in). */
  env_platforms?: string[];
}

export interface ActuatorManifestCapabilityPrerequisites {
  binaries?: string[];
  platforms?: string[];
  env?: string[];
  services?: string[];
  install?: string[] | Record<string, string>;
}

/** SC-02: side-effect class of a governed op. Undeclared defaults to 'write'. */
export type ActuatorEffect = 'read' | 'write' | 'egress' | 'none';

const ACTUATOR_EFFECTS = new Set<ActuatorEffect>(['read', 'write', 'egress', 'none']);

/** Verbs that refine an egress-capable call down to a read via `effect_from`. */
const READ_EFFECT_VALUES = new Set(['get', 'list', 'read', 'query', 'search', 'head', 'options']);

export interface ActuatorManifestCapability {
  op: string;
  description?: string;
  timeout_ms?: number;
  schema_ref?: string;
  platforms: string[];
  requirements?: ActuatorManifestCapabilityRequirements;
  prerequisites?: ActuatorManifestCapabilityPrerequisites;
  implemented?: boolean;
  /** Declared side-effect class; absent means 'write' (fail-safe). */
  effect?: ActuatorEffect;
  /** Input path (e.g. "method", "params.method") refining the effect per call. */
  effect_from?: string;
  /** Input path resolving the governed resource ref for intro/observation stages. */
  resource_ref_from?: string;
}

export interface ActuatorManifestFile {
  actuator_id: string;
  version: string;
  description?: string;
  contract_schema?: string;
  entrypoint?: string;
  resilience_tier?: string;
  recovery_policy?: Record<string, unknown>;
  capabilities?: ActuatorManifestCapability[];
}

export interface ActuatorCatalogEntry {
  n: string;
  path: string;
  d: string;
  s: 'implemented';
  version: string;
  capability_count: number;
  ops: string[];
  contract_schema?: string;
  entrypoint?: string;
  manifest_path: string;
}

/** Manifest ids become directory components in the dispatch module path. */
export function isSafeActuatorId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value.trim());
}

const DEFAULT_ACTUATORS_DIR = pathResolver.rootResolve('libs/actuators');
const ACTUATOR_MANIFEST_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/actuator-manifest.schema.json'
);
const catalogCache = new Map<string, ActuatorCatalogEntry[]>();
const manifestCatalogCache = new Map<string, GovernedCatalog<ActuatorManifestFile>>();

function readManifest(manifestPath: string): ActuatorManifestFile {
  const safeManifestPath = assertSafeRepositoryPath(manifestPath);
  let catalog = manifestCatalogCache.get(safeManifestPath);
  if (!catalog) {
    catalog = defineCatalog<ActuatorManifestFile>({
      id: 'actuator-manifest',
      path: safeManifestPath,
      schema: ACTUATOR_MANIFEST_SCHEMA_PATH,
    });
    manifestCatalogCache.set(safeManifestPath, catalog);
  }
  return catalog.load();
}

/** Load one governed actuator manifest for consumers that need its raw capabilities. */
export function loadActuatorManifest(manifestPath: string): ActuatorManifestFile {
  return readManifest(manifestPath);
}

function listOps(manifest: ActuatorManifestFile): string[] {
  return Array.from(
    new Set((manifest.capabilities || []).map((capability) => capability.op))
  ).sort();
}

export function loadActuatorManifestCatalog(
  actuatorsDir = DEFAULT_ACTUATORS_DIR,
  options: { lenient?: boolean } = {}
): ActuatorCatalogEntry[] {
  const dir = assertSafeRepositoryPath(pathResolver.rootResolve(actuatorsDir), {
    allowMissingLeaf: true,
  });
  const cached = catalogCache.get(dir);
  if (cached) {
    return cached;
  }

  if (!safeExistsSync(dir)) {
    catalogCache.set(dir, []);
    return [];
  }

  const catalog: ActuatorCatalogEntry[] = [];
  const relativeDir = path.relative(pathResolver.rootDir(), dir) || path.basename(dir);
  for (const entry of safeReaddir(dir).sort()) {
    const actuatorDir = assertSafeRepositoryPath(path.join(dir, entry));
    if (!safeStat(actuatorDir).isDirectory()) {
      continue;
    }

    const manifestPath = assertSafeRepositoryPath(path.join(actuatorDir, 'manifest.json'));
    if (!safeExistsSync(manifestPath)) {
      continue;
    }

    let manifest;
    try {
      manifest = readManifest(manifestPath);
    } catch (error) {
      // lenient (op->capability lookup): one corrupt manifest must not take
      // down every other op's preflight — skip it, never fail the read.
      if (!options.lenient) throw error;
      logger.warn(
        `[actuator-manifest-index] skipping unreadable manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (!manifest.actuator_id) {
      continue;
    }
    if (!isSafeActuatorId(manifest.actuator_id)) {
      throw new Error(`[ACTUATOR_MANIFEST_SCOPE] invalid actuator id: ${manifest.actuator_id}`);
    }

    catalog.push({
      n: manifest.actuator_id,
      path: path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry),
      d: manifest.description || 'No description available.',
      s: 'implemented',
      version: manifest.version || '0.0.0',
      capability_count: Array.isArray(manifest.capabilities) ? manifest.capabilities.length : 0,
      ops: listOps(manifest),
      contract_schema: manifest.contract_schema,
      entrypoint: manifest.entrypoint,
      manifest_path: path.relative(pathResolver.rootDir(), manifestPath),
    });
  }

  catalogCache.set(dir, catalog);
  return catalog;
}

export function buildActuatorManifestIndexSnapshot(entries: ActuatorCatalogEntry[]) {
  return {
    v: '2.2.0',
    t: entries.length,
    u: nowIso(),
    actuators: entries.map(({ manifest_path: _manifestPath, ...entry }) => entry),
  };
}

/**
 * SC-02: read a dotted input path ("method", "params.path") from a merged
 * call input record.
 */
function readInputPath(input: Record<string, unknown>, pathExpr: string): unknown {
  const parts = pathExpr.split('.').filter(Boolean);
  let node: unknown = input;
  for (const part of parts) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * SC-02: the declared effect of a capability, refined by `effect_from` when
 * the input selects a read-only verb. Undeclared capabilities default to
 * 'write' — the fail-safe class.
 */
export function resolveCapabilityEffect(
  capability: ActuatorManifestCapability,
  input?: Record<string, unknown>
): ActuatorEffect {
  const declared: ActuatorEffect =
    capability.effect && ACTUATOR_EFFECTS.has(capability.effect) ? capability.effect : 'write';
  if (declared === 'egress' && capability.effect_from && input) {
    const value = readInputPath(input, capability.effect_from);
    if (typeof value === 'string' && READ_EFFECT_VALUES.has(value.trim().toLowerCase())) {
      return 'read';
    }
  }
  return declared;
}

/**
 * SC-02: the governed resource ref an op touches, when the manifest declares
 * `resource_ref_from` and the input carries a value there.
 */
export function resolveCapabilityResourceRef(
  capability: ActuatorManifestCapability,
  input?: Record<string, unknown>
): string | undefined {
  if (!capability.resource_ref_from || !input) return undefined;
  const value = readInputPath(input, capability.resource_ref_from);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

let opCapabilityIndex: Map<string, ActuatorManifestCapability> | null = null;

/** Test seam: drop the cached op → capability index after manifest changes. */
export function resetOpCapabilityIndex(): void {
  opCapabilityIndex = null;
}

/**
 * Map a call op name ("system:keyboard", "service:api") to its manifest
 * capability. The call prefix is the actuator id minus '-actuator'; the
 * capability name is the first segment after the prefix, so namespaced
 * sub-ops ("system:computer_interaction:keyboard") resolve to their parent
 * capability.
 */
export function lookupOpCapability(op: string): ActuatorManifestCapability | undefined {
  if (!opCapabilityIndex) {
    opCapabilityIndex = new Map();
    for (const entry of loadActuatorManifestCatalog(DEFAULT_ACTUATORS_DIR, { lenient: true })) {
      const prefix = entry.n.replace(/-actuator$/u, '');
      const manifest = readManifest(pathResolver.rootResolve(entry.manifest_path));
      for (const capability of manifest.capabilities ?? []) {
        opCapabilityIndex.set(`${prefix}:${capability.op}`, capability);
      }
    }
  }
  const separator = op.indexOf(':');
  if (separator < 0) return undefined;
  const prefix = op.slice(0, separator);
  const rest = op.slice(separator + 1);
  const capOp = rest.includes(':') ? rest.slice(0, rest.indexOf(':')) : rest;
  return opCapabilityIndex.get(`${prefix}:${capOp}`);
}

/**
 * SC-02: resolve the runtime effect class for a call. Unknown or undeclared
 * ops resolve to 'write' — fail-safe until manifests declare otherwise.
 */
export function resolveOpEffect(op: string, input?: Record<string, unknown>): ActuatorEffect {
  const capability = lookupOpCapability(op);
  if (!capability) return 'write';
  return resolveCapabilityEffect(capability, input);
}
