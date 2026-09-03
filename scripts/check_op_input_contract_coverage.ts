import { loadActuatorOpDiscoveryAtPath } from '@agent/core/actuator-op-discovery';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';

const DISCOVERY_PATH = pathResolver.knowledge('product/orchestration/actuator-op-discovery.json');

type DiscoveryFile = {
  actuators?: Array<{
    n?: string;
    ops?: Array<{
      op?: string;
      input_schema?: Record<string, unknown>;
      examples?: Array<Record<string, unknown>>;
    }>;
  }>;
};

type ContractCoverageBaseline = {
  version: 1;
  inferred_legacy: number;
};

function resolveBaselinePath(): string {
  return resolveCiGateBaselinePath('op-input-contract-coverage');
}

function readDiscovery(): DiscoveryFile {
  return loadActuatorOpDiscoveryAtPath(DISCOVERY_PATH);
}

export function findOpInputContractViolations(discovery: DiscoveryFile): string[] {
  const violations: string[] = [];
  let inferredLegacyCount = 0;
  const baselinePath = resolveBaselinePath();

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
  if (safeExistsSync(baselinePath)) {
    const baseline = readJson<ContractCoverageBaseline>(baselinePath);
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
      throw new ScriptExitError(
        1,
        ['FAILED', ...violations.map((violation) => `- ${violation}`)].join('\n')
      );
    }

    context.print('[check:op-input-contract-coverage] OK');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_op_input_contract_coverage.ts') ||
  isDirectScript(import.meta.url, 'check_op_input_contract_coverage.js')
)
  void runCheckOpInputContractCoverage();
