import { main as organizationRolesMain } from './org.js';
import { runOrganizationOperatingModel } from './organization_operating_model.js';
import { currentProcessArgv, defineScript, isDirectScript } from './lib/harness.js';

/**
 * The organization facade owns both the operating model and role authoring.
 * Role authoring remains implemented in its focused module, but callers no
 * longer need a second top-level `org` entrypoint to reach it.
 */
export async function main(args: string[] = currentProcessArgv().slice(2)): Promise<void> {
  if (args[0] === 'role') {
    await organizationRolesMain(args);
    return;
  }
  await runOrganizationOperatingModel(args);
}

export const runOrganization = defineScript({
  name: 'organization',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'organization.ts') ||
  isDirectScript(import.meta.url, 'organization.js')
)
  void runOrganization();
