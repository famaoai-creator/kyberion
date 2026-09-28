/** Domain barrel — public surface for libs/core/project */
export * from './project-management.js';
export * from './project-mission-ledger.js';
export * from './project-operational-state-links.js';
export type {
  ProjectOperationalStateSource,
  ProjectOperationalState,
  ProjectOperationalStateQuery,
  ProjectOperationalStateMissionContext,
} from './project-operational-state-registry.js';
export {
  projectOperationalStateDir,
  projectOperationalStatePath,
  validateProjectOperationalState,
  saveProjectOperationalState,
  loadProjectOperationalState,
  listProjectOperationalStates,
  listProjectOperationalStatePaths,
  syncProjectOperationalStateFromMission,
} from './project-operational-state-registry.js';
export * from './project-registry.js';
export * from './project-state-sync.js';
export * from './project-track-registry.js';
export * from './project-trust.js';
