import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import type { ActuatorOpDescription } from './actuator-sdk.js';

export interface ActuatorOpDiscoveryRecord {
  n: string;
  path: string;
  source: 'describeOps' | 'manifest' | 'registry';
  ops: ActuatorOpDiscoveryOperation[];
}

export type ActuatorOpDiscoveryOperation = Omit<ActuatorOpDescription, 'input_schema'> & {
  input_schema?: Record<string, unknown>;
};

export interface ActuatorOpDiscoveryFile {
  v: string;
  actuators: ActuatorOpDiscoveryRecord[];
}

const ACTUATOR_OP_DISCOVERY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/actuator-op-discovery.schema.json'
);
const ACTUATOR_OP_DISCOVERY_PATH = pathResolver.knowledge(
  'product/orchestration/actuator-op-discovery.json'
);

export function loadActuatorOpDiscoveryAtPath(
  filePath = ACTUATOR_OP_DISCOVERY_PATH
): ActuatorOpDiscoveryFile {
  return defineCatalog<ActuatorOpDiscoveryFile>({
    id: 'actuator-op-discovery',
    path: filePath,
    schema: ACTUATOR_OP_DISCOVERY_SCHEMA_PATH,
  }).load();
}
