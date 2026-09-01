import { main as organizationMain } from './organization.js';
import { main as projectControllerMain } from './project_controller.js';

export async function runGovernedController(
  entrypointId: string,
  args: string[]
): Promise<void | undefined> {
  switch (entrypointId) {
    case 'organization-model':
      await organizationMain(args);
      return;
    case 'project-controller':
      await projectControllerMain(args);
      return;
    default:
      return undefined;
  }
}
