import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { loadActuatorManifestCatalog } from '@agent/core/actuator-manifest-index';
import type { ActuatorOpDescription } from '@agent/core/actuator-sdk';
import { loadActuatorOpRegistry, type PipelineStepType } from '@agent/core/actuator-op-registry';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import { getOpInputContract } from '@agent/core/op-input-contracts';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineGenerator, isDirectScript } from './lib/harness.js';

interface ManifestPipelineOp {
  op?: string;
  note?: string;
}

interface MediaManifestFile {
  actuator_id?: string;
  description?: string;
  version?: string;
  pipeline_ops?: Partial<Record<Exclude<PipelineStepType, 'control'>, ManifestPipelineOp[]>>;
}

interface DomainOpRegistry {
  capture?: string[];
  control?: string[];
  transform?: string[];
  apply?: string[];
}

interface ActuatorOpRegistryFile {
  $schema?: string;
  version: string;
  description: string;
  shared_capture_ops: string[];
  shared_transform_ops: string[];
  shared_apply_ops: string[];
  operation_timeouts_ms?: Record<string, number>;
  domains: Record<string, DomainOpRegistry>;
}

interface OpDiscoveryRecord {
  n: string;
  path: string;
  source: 'describeOps' | 'manifest' | 'registry';
  ops: ActuatorOpDescription[];
}

interface OpDiscoveryReport {
  v: string;
  actuators: OpDiscoveryRecord[];
}

type DescribeOpsSource = () => ActuatorOpDescription[];

/**
 * AR-02: discover self-describing actuator catalogs from the manifest-backed
 * actuator directories. Keeping the source list in the manifests means a new
 * actuator is picked up by this generator without a second hand-maintained
 * import table.
 */
async function loadDescribeOpsSources(
  manifestCatalog: ReturnType<typeof loadActuatorManifestCatalog>
): Promise<Record<string, DescribeOpsSource>> {
  const runtimeModuleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entries = await Promise.all(
    manifestCatalog.map(async (entry) => {
      const javascriptPath = path.resolve(runtimeModuleRoot, entry.path, 'src/op-catalog.js');
      const sourcePath = path.resolve(runtimeModuleRoot, entry.path, 'src/op-catalog.ts');
      const modulePath = assertSafeRepositoryPath(
        safeExistsSync(javascriptPath) ? javascriptPath : sourcePath,
        { allowMissingLeaf: true }
      );
      if (!safeExistsSync(modulePath)) return null;
      const loaded = (await import(pathToFileURL(modulePath).href)) as {
        describeOps?: unknown;
      };
      if (typeof loaded.describeOps !== 'function') {
        throw new Error(`Actuator ${entry.n} has no exported describeOps catalog`);
      }
      return [entry.n, loaded.describeOps as DescribeOpsSource] as const;
    })
  );
  return Object.fromEntries(
    entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  );
}

function enrichDescribedOp(item: {
  op: string;
  kind: PipelineStepType;
  input_schema?: unknown;
  examples?: Array<Record<string, unknown>>;
}): ActuatorOpDescription {
  return { ...item };
}

const REGISTRY_PATH = pathResolver.knowledge('product/governance/actuator-op-registry.json');
const DISCOVERY_PATH = pathResolver.knowledge('product/orchestration/actuator-op-discovery.json');
const MEDIA_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/media-actuator/manifest.json');

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function normalizeDomainRegistry(registry: DomainOpRegistry | undefined): DomainOpRegistry {
  return {
    capture: uniqueSorted(registry?.capture ?? []),
    transform: uniqueSorted(registry?.transform ?? []),
    apply: uniqueSorted(registry?.apply ?? []),
    ...(registry?.control?.length ? { control: uniqueSorted(registry.control) } : {}),
  };
}

function annotateOp(domain: string, op: string, kind: PipelineStepType) {
  const contract = getOpInputContract(domain as 'browser' | 'file' | 'system', op);
  return contract
    ? {
        op,
        kind,
        input_schema: contract.schema,
        examples: contract.examples,
      }
    : { op, kind };
}

function loadMediaManifest(): MediaManifestFile | null {
  if (!safeExistsSync(MEDIA_MANIFEST_PATH)) {
    return null;
  }
  return defineCatalog<MediaManifestFile>({
    id: 'media-actuator-manifest',
    path: MEDIA_MANIFEST_PATH,
    schema: pathResolver.knowledge('product/schemas/actuator-manifest.schema.json'),
  }).load();
}

function buildMediaOpsFromManifest(manifest: MediaManifestFile | null): DomainOpRegistry {
  const pipelineOps = manifest?.pipeline_ops || {};
  return {
    capture: uniqueSorted((pipelineOps.capture || []).map((item) => String(item.op || ''))),
    transform: uniqueSorted((pipelineOps.transform || []).map((item) => String(item.op || ''))),
    apply: uniqueSorted((pipelineOps.apply || []).map((item) => String(item.op || ''))),
  };
}

function buildCurrentRegistryBase(): ActuatorOpRegistryFile {
  const registry = loadActuatorOpRegistry();
  return {
    $schema: '../schemas/actuator-op-registry.schema.json',
    version: registry.version || '1.0.0',
    description:
      registry.description ||
      'Actuator operation registry. Defines which ops belong to each domain and shared op pools.',
    shared_capture_ops: uniqueSorted(registry.shared_capture_ops || []),
    shared_transform_ops: uniqueSorted(registry.shared_transform_ops || []),
    shared_apply_ops: uniqueSorted(registry.shared_apply_ops || []),
    ...(registry.operation_timeouts_ms
      ? { operation_timeouts_ms: { ...registry.operation_timeouts_ms } }
      : {}),
    domains: registry.domains || {},
  };
}

function buildOpDiscoveryReport(
  manifestCatalog: ReturnType<typeof loadActuatorManifestCatalog>,
  registry: ActuatorOpRegistryFile,
  describeOpsSources: Record<string, DescribeOpsSource>
): OpDiscoveryReport {
  const mediaManifest = loadMediaManifest();
  const report: OpDiscoveryRecord[] = [];
  for (const entry of manifestCatalog) {
    const actuatorId = entry.n;
    const describe = describeOpsSources[actuatorId];
    if (describe) {
      const ops = describe();
      report.push({
        n: actuatorId,
        path: entry.path,
        source: 'describeOps',
        ops: ops.map((item) => enrichDescribedOp(item)),
      });
      continue;
    }

    if (actuatorId === 'media-actuator' && mediaManifest?.pipeline_ops) {
      const mediaOps = buildMediaOpsFromManifest(mediaManifest);
      report.push({
        n: actuatorId,
        path: entry.path,
        source: 'manifest',
        ops: [
          ...mediaOps.capture.map((op) => enrichDescribedOp({ op, kind: 'capture' as const })),
          ...mediaOps.transform.map((op) => enrichDescribedOp({ op, kind: 'transform' as const })),
          ...mediaOps.apply.map((op) => enrichDescribedOp({ op, kind: 'apply' as const })),
        ],
      });
      continue;
    }

    const domainName = actuatorId.replace(/-actuator$/, '');
    const domainOps = registry.domains[domainName] || {};
    report.push({
      n: actuatorId,
      path: entry.path,
      source: 'registry',
      ops: [
        ...(domainOps.capture || []).map((op) => annotateOp(domainName, op, 'capture')),
        ...(domainOps.transform || []).map((op) => annotateOp(domainName, op, 'transform')),
        ...(domainOps.apply || []).map((op) => annotateOp(domainName, op, 'apply')),
        ...(domainOps.control || []).map((op) => annotateOp(domainName, op, 'control')),
      ],
    });
  }

  return {
    v: '1.0.0',
    actuators: report,
  };
}

function buildGeneratedRegistry(
  describeOpsSources: Record<string, DescribeOpsSource>
): ActuatorOpRegistryFile {
  const registry = buildCurrentRegistryBase();
  const manifest = loadMediaManifest();
  const mediaOps = buildMediaOpsFromManifest(manifest);
  const domains: Record<string, DomainOpRegistry> = {
    ...registry.domains,
    media: normalizeDomainRegistry(mediaOps),
  };
  for (const [actuatorId, describe] of Object.entries(describeOpsSources)) {
    const domainName = actuatorId.replace(/-actuator$/, '');
    const ops = describe();
    domains[domainName] = normalizeDomainRegistry({
      capture: ops.filter((item) => item.kind === 'capture').map((item) => item.op),
      transform: ops.filter((item) => item.kind === 'transform').map((item) => item.op),
      apply: ops.filter((item) => item.kind === 'apply').map((item) => item.op),
      control: ops.filter((item) => item.kind === 'control').map((item) => item.op),
    });
  }

  return {
    ...registry,
    domains: Object.fromEntries(
      Object.entries(domains)
        .map(([domain, value]) => [domain, normalizeDomainRegistry(value)] as const)
        .sort(([left], [right]) => left.localeCompare(right))
    ),
  };
}

// Format with the repo's prettier config: `pnpm format` rewrites these JSON
// files, so plain JSON.stringify output would immediately re-drift.
async function stringifyJson(value: unknown, filePath: string): Promise<string> {
  const config = (await resolvePrettierConfig(filePath)) ?? {};
  return prettierFormat(JSON.stringify(value, null, 2), { ...config, parser: 'json' });
}

export const main = defineGenerator({
  id: 'op-registry',
  outputs: [REGISTRY_PATH, DISCOVERY_PATH],
  async render() {
    const manifestCatalog = loadActuatorManifestCatalog();
    const describeOpsSources = await loadDescribeOpsSources(manifestCatalog);
    const registry = buildGeneratedRegistry(describeOpsSources);
    const discovery = buildOpDiscoveryReport(manifestCatalog, registry, describeOpsSources);
    return [
      { path: REGISTRY_PATH, content: await stringifyJson(registry, REGISTRY_PATH) },
      { path: DISCOVERY_PATH, content: await stringifyJson(discovery, DISCOVERY_PATH) },
    ];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_op_registry.ts') ||
  isDirectScript(import.meta.url, 'generate_op_registry.js')
)
  void main();
