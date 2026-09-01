import { handleDeploymentAction } from './deployment-actuator-helpers.js';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

export const handleAction = handleDeploymentAction;
export const actuator = defineCatalogBackedActuator({
  id: 'deployment-actuator',
  describeOps,
  handleAction,
});
export { describeOps };
