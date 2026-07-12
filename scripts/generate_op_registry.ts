import * as path from 'node:path';
import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { loadActuatorManifestCatalog } from '@agent/core';
import { pathResolver, safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';
import { getOpInputContract } from '@agent/core/op-input-contracts';
import { describeOps as describeSystemOps } from '@actuator/system';
import { describeOps as describeBrowserOps } from '../libs/actuators/browser-actuator/src/op-catalog.js';
import { describeOps as describeCodeOps } from '../libs/actuators/code-actuator/src/op-catalog.js';
import { describeOps as describeFileOps } from '../libs/actuators/file-actuator/src/op-catalog.js';
import { describeOps as describeModelingOps } from '../libs/actuators/modeling-actuator/src/op-catalog.js';
import { describeOps as describeProcessOps } from '../libs/actuators/process-actuator/src/op-catalog.js';
import { describeOps as describeTerminalOps } from '../libs/actuators/terminal-actuator/src/op-catalog.js';
import { describeOps as describeSecretOps } from '../libs/actuators/secret-actuator/src/op-catalog.js';
import { describeOps as describeApprovalOps } from '../libs/actuators/approval-actuator/src/op-catalog.js';
import { describeOps as describeAgentOps } from '../libs/actuators/agent-actuator/src/op-catalog.js';
import { describeOps as describeArtifactOps } from '../libs/actuators/artifact-actuator/src/op-catalog.js';
import { describeOps as describeNetworkOps } from '../libs/actuators/network-actuator/src/op-catalog.js';
import { describeOps as describeWisdomOps } from '../libs/actuators/wisdom-actuator/src/op-catalog.js';
import { describeOps as describeBlockchainOps } from '../libs/actuators/blockchain-actuator/src/op-catalog.js';
import { describeOps as describeBuildOps } from '../libs/actuators/build-actuator/src/op-catalog.js';
import { describeOps as describeCalendarOps } from '../libs/actuators/calendar-actuator/src/op-catalog.js';
import { describeOps as describeEmailOps } from '../libs/actuators/email-actuator/src/op-catalog.js';
import { describeOps as describePresenceOps } from '../libs/actuators/presence-actuator/src/op-catalog.js';

// AR-02: actuators that self-describe their op surface. The registry and
// discovery index are generated from these; check:op-registry fails on
// drift between the committed files and this source of truth.
const DESCRIBE_OPS_SOURCES: Record<
  string,
  () => Array<{
    op: string;
    kind: PipelineOpKind;
    input_schema?: Record<string, unknown>;
    examples?: Array<Record<string, unknown>>;
  }>
> = {
  'system-actuator': describeSystemOps,
  'file-actuator': describeFileOps,
  'network-actuator': describeNetworkOps,
  'code-actuator': describeCodeOps,
  'modeling-actuator': describeModelingOps,
  'wisdom-actuator': describeWisdomOps,
  'browser-actuator': describeBrowserOps,
  'process-actuator': describeProcessOps,
  'terminal-actuator': describeTerminalOps,
  'secret-actuator': describeSecretOps,
  'approval-actuator': describeApprovalOps,
  'agent-actuator': describeAgentOps,
  'artifact-actuator': describeArtifactOps,
  'blockchain-actuator': describeBlockchainOps,
  'build-actuator': describeBuildOps,
  'calendar-actuator': describeCalendarOps,
  'email-actuator': describeEmailOps,
  'presence-actuator': describePresenceOps,
};

type PipelineOpKind = 'capture' | 'transform' | 'apply' | 'control';

interface ManifestPipelineOp {
  op?: string;
  note?: string;
}

interface MediaManifestFile {
  actuator_id?: string;
  description?: string;
  version?: string;
  pipeline_ops?: Partial<Record<Exclude<PipelineOpKind, 'control'>, ManifestPipelineOp[]>>;
}

interface DomainOpRegistry {
  capture?: string[];
  transform?: string[];
  apply?: string[];
}

interface ActuatorOpRegistryFile {
  version: string;
  description: string;
  shared_capture_ops: string[];
  shared_transform_ops: string[];
  shared_apply_ops: string[];
  domains: Record<string, DomainOpRegistry>;
}

interface OpDiscoveryRecord {
  n: string;
  path: string;
  source: 'describeOps' | 'manifest' | 'registry';
  ops: Array<{
    op: string;
    kind: PipelineOpKind;
    input_schema?: Record<string, unknown>;
    examples?: Array<Record<string, unknown>>;
  }>;
}

interface OpDiscoveryReport {
  v: string;
  actuators: OpDiscoveryRecord[];
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
  };
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }) || '{}')) as T;
}

function annotateOp(domain: string, op: string, kind: PipelineOpKind) {
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
  return loadJson<MediaManifestFile>(MEDIA_MANIFEST_PATH);
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
  const registry = loadJson<ActuatorOpRegistryFile>(REGISTRY_PATH);
  return {
    version: registry.version || '1.0.0',
    description:
      registry.description ||
      'Actuator operation registry. Defines which ops belong to each domain and shared op pools.',
    shared_capture_ops: uniqueSorted(registry.shared_capture_ops || []),
    shared_transform_ops: uniqueSorted(registry.shared_transform_ops || []),
    shared_apply_ops: uniqueSorted(registry.shared_apply_ops || []),
    domains: registry.domains || {},
  };
}

function buildOpDiscoveryReport(
  manifestCatalog: ReturnType<typeof loadActuatorManifestCatalog>,
  registry: ActuatorOpRegistryFile
): OpDiscoveryReport {
  const mediaManifest = loadMediaManifest();
  const report: OpDiscoveryRecord[] = [];
  for (const entry of manifestCatalog) {
    const actuatorId = entry.n;
    const describe = DESCRIBE_OPS_SOURCES[actuatorId];
    if (describe) {
      const ops = describe();
      report.push({
        n: actuatorId,
        path: entry.path,
        source: 'describeOps',
        ops: ops.map((item) => ({
          op: item.op,
          kind: item.kind,
          input_schema: (item as { input_schema?: Record<string, unknown> }).input_schema,
          examples: (item as { examples?: Array<Record<string, unknown>> }).examples,
        })),
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
          ...mediaOps.capture.map((op) => ({ op, kind: 'capture' as const })),
          ...mediaOps.transform.map((op) => ({ op, kind: 'transform' as const })),
          ...mediaOps.apply.map((op) => ({ op, kind: 'apply' as const })),
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
      ],
    });
  }

  return {
    v: '1.0.0',
    actuators: report,
  };
}

function buildGeneratedRegistry(): ActuatorOpRegistryFile {
  const registry = buildCurrentRegistryBase();
  const manifest = loadMediaManifest();
  const mediaOps = buildMediaOpsFromManifest(manifest);
  const domains: Record<string, DomainOpRegistry> = {
    ...registry.domains,
    media: normalizeDomainRegistry(mediaOps),
  };
  for (const [actuatorId, describe] of Object.entries(DESCRIBE_OPS_SOURCES)) {
    const domainName = actuatorId.replace(/-actuator$/, '');
    const ops = describe();
    domains[domainName] = normalizeDomainRegistry({
      capture: ops.filter((item) => item.kind === 'capture').map((item) => item.op),
      transform: ops.filter((item) => item.kind === 'transform').map((item) => item.op),
      apply: ops.filter((item) => item.kind === 'apply').map((item) => item.op),
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

function writeOutputs(registryJson: string, discoveryJson: string): void {
  safeWriteFile(REGISTRY_PATH, registryJson);
  safeWriteFile(DISCOVERY_PATH, discoveryJson);
}

function readCurrentFiles(): { registry: string; discovery: string | null } {
  const registry = String(safeReadFile(REGISTRY_PATH, { encoding: 'utf8' }) || '');
  const discovery = safeExistsSync(DISCOVERY_PATH)
    ? String(safeReadFile(DISCOVERY_PATH, { encoding: 'utf8' }) || '')
    : null;
  return { registry, discovery };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const shouldCheck = argv.includes('--check');
  const shouldWrite = argv.includes('--write') || !shouldCheck;
  // withExecutionContext restores env synchronously when its callback
  // returns, so every secure-io access stays inside a sync callback and the
  // async prettier formatting runs between the two context sections.
  const built = withExecutionContext('ecosystem_architect', () => {
    const manifestCatalog = loadActuatorManifestCatalog();
    const registry = buildGeneratedRegistry();
    const discovery = buildOpDiscoveryReport(manifestCatalog, registry);
    return { registry, discovery };
  });
  const nextRegistry = await stringifyJson(built.registry, REGISTRY_PATH);
  const nextDiscovery = await stringifyJson(built.discovery, DISCOVERY_PATH);
  return withExecutionContext('ecosystem_architect', () => {
    if (shouldCheck) {
      const current = readCurrentFiles();
      const registryMatches = current.registry === nextRegistry;
      const discoveryMatches = current.discovery === nextDiscovery;
      if (registryMatches && discoveryMatches) {
        console.log('op registry is up to date');
        return;
      }
      console.error('op registry drift detected');
      if (!registryMatches)
        console.error(`- ${path.relative(pathResolver.rootDir(), REGISTRY_PATH)} differs`);
      if (!discoveryMatches)
        console.error(`- ${path.relative(pathResolver.rootDir(), DISCOVERY_PATH)} differs`);
      process.exitCode = 1;
      return;
    }

    if (shouldWrite) {
      writeOutputs(nextRegistry, nextDiscovery);
      console.log(
        `wrote ${path.relative(pathResolver.rootDir(), REGISTRY_PATH)} and ${path.relative(pathResolver.rootDir(), DISCOVERY_PATH)}`
      );
    }
  });
}

if (process.argv[1] && /generate_op_registry\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
