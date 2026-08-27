import { main as organizationRolesMain } from './org.js';
import { runOrganizationOperatingModel } from './organization_operating_model.js';
import { main as projectControllerMain } from './project_controller.js';

export async function runGovernedController(
  entrypointId: string,
  args: string[]
): Promise<void | undefined> {
  switch (entrypointId) {
    case 'organization-model':
      await runOrganizationOperatingModel(args);
      return;
    case 'organization-roles':
      await organizationRolesMain(args);
      return;
    case 'project-controller':
      await projectControllerMain(args);
      return;
    default:
      return undefined;
  }
}
