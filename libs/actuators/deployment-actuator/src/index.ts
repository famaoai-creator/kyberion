/**
 * deployment-actuator — dogfoods `defineActuator` (declarative SDK) while
 * keeping `handleAction` for ADF pipeline callers that still pass the legacy
 * action envelope.
 */
import { defineActuator } from '@agent/core/actuator/actuator-sdk';
import { handleDeploymentAction, type DeploymentParams } from './deployment-actuator-helpers.js';
import { DEPLOYMENT_SCHEMA, describeOps } from './op-catalog.js';

function asDeploymentParams(value: unknown): DeploymentParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[deploy_release] input must be an object');
  }
  const record = value as Record<string, unknown>;
  const mission_id = String(record.mission_id || '').trim();
  const project_name = String(record.project_name || '').trim();
  const version = String(record.version || '').trim();
  const environment = String(record.environment || '').trim();
  if (!mission_id || !project_name || !version || !environment) {
    throw new Error('[deploy_release] requires mission_id, project_name, version, and environment');
  }
  const release_notes_path =
    typeof record.release_notes_path === 'string' && record.release_notes_path.trim()
      ? record.release_notes_path.trim()
      : undefined;
  return {
    mission_id,
    project_name,
    version,
    environment,
    ...(release_notes_path ? { release_notes_path } : {}),
  };
}

export const handleAction = handleDeploymentAction;

/** Canonical SDK surface — prefer this over hand-rolled dispatch tables. */
export const actuator = defineActuator({
  id: 'deployment-actuator',
  ops: {
    deploy_release: {
      kind: 'apply',
      input_schema: DEPLOYMENT_SCHEMA,
      validateInput: asDeploymentParams,
      handler: async (params) => handleDeploymentAction({ action: 'deploy_release', params }),
    },
  },
});

export { describeOps };
