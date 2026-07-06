import { pathResolver, safeReadFile } from '@agent/core';
import { listOpInputContracts, type OpInputDomain } from '@agent/core/op-input-contracts';

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

const DISCOVERY_PATH = pathResolver.knowledge('product/orchestration/actuator-op-discovery.json');

const DISCOVERY_DOMAINS: Array<{ domain: OpInputDomain; actuator: string }> = [
  { domain: 'browser', actuator: 'browser-actuator' },
  { domain: 'file', actuator: 'file-actuator' },
  { domain: 'system', actuator: 'system-actuator' },
];

const TARGET_OPS: Record<OpInputDomain, string[]> = {
  browser: ['goto', 'snapshot', 'click', 'fill', 'press', 'wait', 'content'],
  file: [
    'glob_files',
    'list',
    'read',
    'read_file',
    'read_json',
    'exists',
    'search',
    'stat',
    'tail',
    'write',
    'write_file',
    'write_artifact',
    'append',
    'delete',
    'mkdir',
    'copy',
    'move',
  ],
  system: [
    'exec',
    'shell',
    'open_url',
    'open_file',
    'read_file',
    'read_json',
    'write_file',
    'write_artifact',
    'write_json',
    'notify',
    'app_quit',
    'process_kill',
    'mkdir',
  ],
};

function readDiscovery(): DiscoveryFile {
  return JSON.parse(
    String(safeReadFile(DISCOVERY_PATH, { encoding: 'utf8' }) || '{}')
  ) as DiscoveryFile;
}

export function findMissingOpInputContractCoverage(): string[] {
  const discovery = readDiscovery();
  const violations: string[] = [];

  for (const { domain, actuator } of DISCOVERY_DOMAINS) {
    const contracts = listOpInputContracts(domain);
    const discoveryOps = new Map(
      (discovery.actuators || [])
        .find((entry) => entry.n === actuator)
        ?.ops?.map((item) => [String(item.op || ''), item] as const) || []
    );

    for (const op of TARGET_OPS[domain]) {
      if (!contracts[op]) {
        continue;
      }
      const entry = discoveryOps.get(op);
      if (!entry) {
        violations.push(`${actuator}: missing discovery entry for contract-backed op ${op}`);
        continue;
      }
      if (!entry.input_schema) {
        violations.push(`${actuator}: missing input_schema for contract-backed op ${op}`);
      }
      if (!Array.isArray(entry.examples) || entry.examples.length === 0) {
        violations.push(`${actuator}: missing examples for contract-backed op ${op}`);
      }
    }
  }

  return violations;
}

function main(): void {
  const violations = findMissingOpInputContractCoverage();
  if (violations.length > 0) {
    console.error('[check:op-input-contract-coverage] FAILED');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log('[check:op-input-contract-coverage] OK');
}

if (process.argv[1] && /check_op_input_contract_coverage\.(ts|js)$/.test(process.argv[1])) {
  main();
}
