import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import { readJson } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

type DiscoveryEntry = {
  n?: string;
  ops?: Array<{
    op?: string;
    input_schema?: Record<string, unknown>;
    examples?: Array<Record<string, unknown>>;
  }>;
};

type DiscoveryFile = {
  actuators?: DiscoveryEntry[];
};

type GateManifest = {
  gates?: Array<{ id?: string; baseline?: string }>;
};

const DISCOVERY_PATH = pathResolver.knowledge('product/orchestration/actuator-op-discovery.json');
const GATE_MANIFEST_PATH = pathResolver.knowledge('product/governance/ci-gates.json');

type ContractCoverageBaseline = {
  version: 1;
  inferred_legacy: number;
};

function resolveBaselinePath(): string {
  const baseline = readJson<GateManifest>(GATE_MANIFEST_PATH).gates?.find(
    (gate) => gate.id === 'op-input-contract-coverage'
  )?.baseline;
  if (!baseline) {
    throw new Error('op-input-contract-coverage gate must declare a baseline path');
  }
  return pathResolver.rootResolve(baseline);
}

const BASELINE_PATH = resolveBaselinePath();

function readDiscovery(): DiscoveryFile {
  return JSON.parse(
    String(safeReadFile(DISCOVERY_PATH, { encoding: 'utf8' }) || '{}')
  ) as DiscoveryFile;
}

export function findOpInputContractViolations(discovery: DiscoveryFile): string[] {
  const violations: string[] = [];
  let inferredLegacyCount = 0;

  for (const actuator of discovery.actuators || []) {
    for (const entry of actuator.ops || []) {
      const identity = `${actuator.n}:${String(entry.op || '')}`;
      if (!entry.input_schema) {
        violations.push(`${identity}: missing input_schema`);
        continue;
      }
      const contractMarker = entry.input_schema['x-kyberion-contract'];
      if (contractMarker === 'inferred-legacy') inferredLegacyCount += 1;
      if (contractMarker === 'legacy-open') {
        violations.push(`${identity}: legacy-open input contract is not permitted`);
      }
      if (!Array.isArray(entry.examples) || entry.examples.length === 0) {
        violations.push(`${identity}: missing examples`);
      }
    }
  }

  // Inferred contracts are deliberately open during the migration. Keep the
  // count visible in the gate output so the migration remains measurable,
  // while avoiding a false-green contract that rejects real pipeline params.
  if (inferredLegacyCount > 0) {
    console.warn(
      `[check:op-input-contract-coverage] ${inferredLegacyCount} inferred-legacy contract(s) remain`
    );
  }
  if (safeExistsSync(BASELINE_PATH)) {
    const baseline = readJson<ContractCoverageBaseline>(BASELINE_PATH);
    if (inferredLegacyCount > baseline.inferred_legacy) {
      violations.push(
        `inferred-legacy contracts increased from ${baseline.inferred_legacy} to ${inferredLegacyCount}`
      );
    }
  }

  return violations;
}

export function findMissingOpInputContractCoverage(): string[] {
  return findOpInputContractViolations(readDiscovery());
}

export const runCheckOpInputContractCoverage = defineScript({
  name: 'check:op-input-contract-coverage',
  flags: [],
  run(context) {
    const violations = findMissingOpInputContractCoverage();
    if (violations.length > 0) {
      console.error('[check:op-input-contract-coverage] FAILED');
      for (const violation of violations) {
        console.error(`- ${violation}`);
      }
      throw new Error(`${violations.length} op input contract coverage violation(s)`);
    }

    context.print('[check:op-input-contract-coverage] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_op_input_contract_coverage.ts') ||
  isDirectScript(import.meta.url, 'check_op_input_contract_coverage.js')
)
  void runCheckOpInputContractCoverage();
