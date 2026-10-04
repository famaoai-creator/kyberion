/** Domain barrel — public surface for libs/core/governance */
export * from './accountability-charter-registry.js';
export * from './accountability-charter.js';
export * from './approval-audit.js';
export * from './approval-cowork-adapter.js';
export * from './approval-gate-summary.js';
export * from './approval-gate.js';
export * from './approval-policy.js';
export * from './approval-store-hygiene.js';
export * from './approval-store.js';
export * from './audit-chain.js';
export * from './audit-forwarder.js';
export * from './autonomous-ops-gate.js';
export * from './governance-action-recorder.js';
export * from './governance-status.js';
export type { AnomalyIndicator } from './kill-switch.js';
export { getAnomalyConfig, onKillSwitchTermination, killSwitch } from './kill-switch.js';
export * from './policy-engine.js';
export * from './org-budget-governor.js';
