import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

export type MissionProcessGovernanceJson = Record<string, any>;

const catalogs = {
  processRegistry: defineCatalog<MissionProcessGovernanceJson>({
    id: 'mission-process-registry',
    path: pathResolver.knowledge('product/governance/mission-process-registry.json'),
    schema: pathResolver.knowledge('product/schemas/mission-process-registry.schema.json'),
  }),
  gateProfileRegistry: defineCatalog<MissionProcessGovernanceJson>({
    id: 'gate-profile-registry',
    path: pathResolver.knowledge('product/governance/gate-profiles/gate-profile-registry.json'),
    schema: pathResolver.knowledge('product/schemas/gate-profile.schema.json'),
  }),
  orchestrationScenarioPack: defineCatalog<MissionProcessGovernanceJson>({
    id: 'mission-orchestration-scenario-pack',
    path: pathResolver.knowledge('product/governance/mission-orchestration-scenario-pack.json'),
    schema: pathResolver.knowledge(
      'product/schemas/mission-orchestration-scenario-pack.schema.json'
    ),
  }),
  taskClassificationScenarioPack: defineCatalog<MissionProcessGovernanceJson>({
    id: 'mission-task-classification-scenarios',
    path: pathResolver.knowledge('product/governance/mission-task-classification-scenarios.json'),
    schema: pathResolver.knowledge(
      'product/schemas/mission-task-classification-scenarios.schema.json'
    ),
  }),
};

export function loadMissionProcessRegistry(): MissionProcessGovernanceJson {
  return catalogs.processRegistry.load();
}

export function loadGateProfileRegistry(): MissionProcessGovernanceJson {
  return catalogs.gateProfileRegistry.load();
}

export function loadMissionOrchestrationScenarioPack(): MissionProcessGovernanceJson {
  return catalogs.orchestrationScenarioPack.load();
}

export function loadMissionTaskClassificationScenarioPack(): MissionProcessGovernanceJson {
  return catalogs.taskClassificationScenarioPack.load();
}
