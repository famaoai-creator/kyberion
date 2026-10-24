import { main as organizationRolesMain } from './org.js';
import { runOrganizationOperatingModel } from './organization_operating_model.js';
import { currentProcessArgv, defineScript, isDirectScript } from './lib/harness.js';

/**
 * The organization facade owns the operating model, role authoring,
 * member identity links (`member link-identity`), SCIM provisioning tokens
 * (`scim-token issue|list|revoke`) and the first-run setup bootstrap
 * (`first-run code`).
 * Role authoring remains implemented in its focused module, but callers no
 * longer need a second top-level `org` entrypoint to reach it.
 */
export async function main(
  args: string[] = currentProcessArgv().slice(2),
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  if (args[0] === 'continuous' && args[1] === 'run') {
    await import('./run_pipeline.js');
    const { runOrganizationContinuousOperations } =
      await import('./organization_continuous_operations.js');
    await runOrganizationContinuousOperations(args.slice(2), print);
    return;
  }
  if (args[0] === 'role') {
    if (args[1] === 'migrate-publication-store') {
      const { runPublicationRoleMigration } =
        await import('./organization_publication_role_migration.js');
      runPublicationRoleMigration(args.slice(2), print);
      return;
    }
    await organizationRolesMain(args);
    return;
  }
  if (args[0] === 'member') {
    const { runOrganizationMember } = await import('./organization_member.js');
    await runOrganizationMember(args.slice(1));
    return;
  }
  if (args[0] === 'participant' || args[0] === 'agent') {
    const { runOrganizationPeople } = await import('./organization_people.js');
    await runOrganizationPeople(args[0], args.slice(1), print);
    return;
  }
  if (args[0] === 'scim-token') {
    const { runOrganizationScimToken } = await import('./organization_scim_token.js');
    await runOrganizationScimToken(args.slice(1));
    return;
  }
  if (args[0] === 'first-run') {
    const { runOrganizationFirstRun } = await import('./organization_first_run.js');
    await runOrganizationFirstRun(args.slice(1));
    return;
  }
  if (args[0] === 'identity') {
    const { runOrganizationIdentity } = await import('./organization_identity.js');
    await runOrganizationIdentity(args.slice(1));
    return;
  }
  if (args[0] === 'operation' && args[1] === 'run' && args[2] === 'execute') {
    // Load the pipeline engine so it registers the nested-pipeline runner.
    await import('./run_pipeline.js');
    const { executeOrganizationOperation } = await import('./organization_operation_execute.js');
    await executeOrganizationOperation(args.slice(3));
    return;
  }
  if (args[0] === 'doctrine' && args[1] === 'issue') {
    const { issueOrganizationDoctrine } = await import('./organization_doctrine.js');
    issueOrganizationDoctrine(args.slice(2), print);
    return;
  }
  if (args[0] === 'doctrine' && args[1] === 'publish') {
    const { publishOrganizationDoctrine } = await import('./organization_doctrine.js');
    await publishOrganizationDoctrine(args.slice(2), print);
    return;
  }
  if (args[0] === 'objective' && args[1] === 'kr' && args[2] === 'measure') {
    const { measureOrganizationObjectives } = await import('./organization_objective_measure.js');
    await measureOrganizationObjectives(args.slice(3), print);
    return;
  }
  if (args[0] === 'objective' && args[1] === 'kr' && args[2] === 'record') {
    const { recordOrganizationObjectiveKr } = await import('./organization_objective_measure.js');
    recordOrganizationObjectiveKr(args.slice(3), print);
    return;
  }
  if (args[0] === 'operation' && args[1] === 'tick') {
    await import('./run_pipeline.js');
    const { tickOrganizationOperations } = await import('./organization_operation_execute.js');
    await tickOrganizationOperations(args.slice(2));
    return;
  }
  await runOrganizationOperatingModel(args);
}

export const runOrganization = defineScript({
  name: 'organization',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'organization.ts') ||
  isDirectScript(import.meta.url, 'organization.js')
)
  void runOrganization();
