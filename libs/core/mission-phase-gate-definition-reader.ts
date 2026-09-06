import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import type { MissionGateDefinition } from './mission-gate-engine.js';

export interface PersistedPhaseGateDefinition {
  mission_id: string;
  phase: string;
  position: 'entry' | 'exit';
  gate: MissionGateDefinition;
}

const PHASE_GATE_DEFINITION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-phase-gate-definition.schema.json'
);

/** Load one persisted gate through the shared schema boundary and mission binding. */
export function loadMissionPhaseGateDefinitionAtPath(
  filePath: string,
  missionId: string
): PersistedPhaseGateDefinition {
  const definition = defineCatalog<PersistedPhaseGateDefinition>({
    id: 'mission-phase-gate-definition',
    path: filePath,
    schema: PHASE_GATE_DEFINITION_SCHEMA_PATH,
  }).load();
  const expectedMissionId = missionId.trim().toUpperCase();
  if (definition.mission_id.trim().toUpperCase() !== expectedMissionId) {
    throw new Error(
      `[MISSION_GATE_SCOPE_MISMATCH] definition belongs to ${definition.mission_id}, expected ${expectedMissionId}`
    );
  }
  return definition;
}
