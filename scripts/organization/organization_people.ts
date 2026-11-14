/** CLI transport for the same owner-authorized organization people facades as HTTP. */
import { createStandardYargs } from '@agent/core/cli-utils';
import { withExecutionContext } from '@agent/core/authority';
import { resolveCliOperatorIdentity } from '@agent/core/governance/cli-operator-principal';
import { resolveScopeContext } from '@agent/core/scope-context';
import type { SurfaceManagementAuthorization } from '@agent/core/surface/surface-management-mutations';
import {
  listManagedOrganizations,
  listOrganizationBusinessRoles,
  listOrganizationParticipants,
  listOrganizationParticipantCandidates,
  setOrganizationParticipant,
  removeOrganizationParticipant,
} from '@agent/core/organization/organization-participants';
import {
  listManagedOrganizationAgents,
  showManagedOrganizationAgent,
  issueManagedOrganizationAgent,
  changeManagedOrganizationAgentLifecycle,
  reassignManagedOrganizationAgentAccountable,
} from '@agent/core/organization/organization-agent-management';

export function resolveOrganizationPeopleCliAuthorization(
  tenantSlug: string
): SurfaceManagementAuthorization {
  const identity = withExecutionContext('sovereign_concierge', () => resolveCliOperatorIdentity());
  if (!identity.principalId?.startsWith('user:'))
    throw new Error(
      'Registered owner required. Complete reviewed onboarding or run pnpm organization member ensure-owner.'
    );
  return {
    memberId: identity.principalId.slice(5),
    actorId: identity.principalId,
    tenantSlug,
    allowedOrganizationIds: 'all',
    allowedProjectIds: 'all',
  };
}

export async function runOrganizationPeople(
  group: 'participant' | 'agent',
  argv: string[],
  print: (value: unknown) => void = (value) =>
    process.stdout.write(
      typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n'
    )
): Promise<void> {
  const actions =
    group === 'participant'
      ? ['list', 'assign', 'unassign', 'set-roles', 'roles']
      : ['list', 'show', 'issue', 'activate', 'suspend', 'retire', 'reassign-accountable'];
  const scope = resolveScopeContext();
  const args = await createStandardYargs([process.execPath, 'organization_people.ts', ...argv])
    .scriptName(`pnpm organization ${group}`)
    .command('$0 [action]', 'Manage organizational responsibilities and identities', (y) =>
      y.positional('action', { choices: actions, default: 'list' })
    )
    .option('tenant', { alias: 'tenant-slug', type: 'string', default: scope.tenant_slug })
    .option('tier', {
      type: 'string',
      choices: ['confidential'] as const,
      default: 'confidential' as const,
      description: 'Tenant organization people records are confidential',
    })
    .option('organization-id', { type: 'string', default: scope.organization_id })
    .option('actor', { type: 'string' })
    .option('role', { type: 'string', array: true, default: [] as string[] })
    .option('expected-version', { type: 'string' })
    .option('nhi-id', { type: 'string' })
    .option('slug', { type: 'string' })
    .option('kind', {
      type: 'string',
      choices: ['agent', 'service'] as const,
      default: 'agent' as const,
    })
    .option('display-name', { type: 'string' })
    .option('accountable-human', { type: 'string' })
    .option('provider-hint', { type: 'string' })
    .option('model-hint', { type: 'string' })
    .option('reason', { type: 'string' })
    .option('include-retired', { type: 'boolean', default: false })
    .option('apply', { type: 'boolean', default: false })
    .option('json', { type: 'boolean', default: false })
    .strict()
    .parse();
  if (args.apply && args.dryRun) throw new Error('Choose either --dry-run or --apply.');
  if (group === 'participant' && args.action === 'roles') {
    print(listOrganizationBusinessRoles());
    return;
  }
  if (!args.tenant) throw new Error('Select a tenant with --tenant <slug> or pnpm scope use.');
  const auth = resolveOrganizationPeopleCliAuthorization(args.tenant);
  const requireText = (value: string | undefined, flag: string): string => {
    if (!value?.trim()) throw new Error(`${flag} is required.`);
    return value.trim();
  };
  if (group === 'participant') {
    if (args.action === 'list') {
      print(
        args.organizationId
          ? await listOrganizationParticipants(auth, args.organizationId)
          : {
              organizations: await listManagedOrganizations(auth),
              candidates: await listOrganizationParticipantCandidates(auth),
              roles: listOrganizationBusinessRoles(),
            }
      );
      return;
    }
    const organizationId = requireText(args.organizationId, '--organization-id');
    const actor = requireText(args.actor, '--actor');
    const knownRoles = new Set(listOrganizationBusinessRoles().map((role) => role.role_id));
    if (args.role.some((role) => !knownRoles.has(role)))
      throw new Error('Select registered responsibilities from participant roles.');
    const current = (await listOrganizationParticipants(auth, organizationId)).find(
      (row) => row.actor === actor
    );
    if (current && !args.expectedVersion)
      throw new Error('Existing assignments require --expected-version from participant list.');
    if (current && args.expectedVersion !== current.version)
      throw new Error('The assignment changed. Refresh participant list before retrying.');
    if (args.action === 'set-roles' && current?.status !== 'active')
      throw new Error(
        'Assign this identity to the organization before setting its responsibilities.'
      );
    if (args.action === 'unassign' && !current)
      throw new Error('Participant assignment not found.');
    if (!args.apply) {
      print({
        status: 'dry-run',
        operation: `participant.${args.action}`,
        organization_id: organizationId,
        actor,
        role_ids: args.role,
        expected_version: args.expectedVersion,
        note: 'Repeat with --apply to save. Organizational responsibilities do not grant tenant access or execution authority.',
      });
      return;
    }
    print(
      args.action === 'unassign'
        ? await removeOrganizationParticipant(auth, {
            organizationId,
            actor,
            expectedVersion: requireText(args.expectedVersion, '--expected-version'),
          })
        : await setOrganizationParticipant(auth, {
            organizationId,
            actor,
            roleIds: args.role,
            expectedVersion: args.expectedVersion,
          })
    );
    return;
  }
  if (args.action === 'list') {
    print(
      await listManagedOrganizationAgents(auth, {
        organizationId: args.organizationId,
        includeRetired: args.includeRetired,
      })
    );
    return;
  }
  if (args.action === 'show') {
    const agent = await showManagedOrganizationAgent(auth, requireText(args.nhiId, '--nhi-id'));
    if (!agent || (args.organizationId && agent.home_organization_id !== args.organizationId))
      throw new Error('Agent not found in the selected authorized organization.');
    print(agent);
    return;
  }
  if (args.action === 'issue') {
    const input = {
      organizationId: requireText(args.organizationId, '--organization-id'),
      slug: requireText(args.slug, '--slug'),
      kind: args.kind,
      displayName: args.displayName,
      accountableHumanId: requireText(args.accountableHuman, '--accountable-human'),
      providerHint: args.providerHint,
      modelHint: args.modelHint,
    };
    if (!args.apply) {
      await listManagedOrganizationAgents(auth, { organizationId: input.organizationId });
      print({
        status: 'dry-run',
        operation: 'agent.issue',
        input,
        note: 'Repeat with --apply to issue this immutable identity.',
      });
      return;
    }
    print(await issueManagedOrganizationAgent(auth, input));
    return;
  }
  const nhiId = requireText(args.nhiId, '--nhi-id');
  const expectedVersion = requireText(args.expectedVersion, '--expected-version');
  const selectedAgent = await showManagedOrganizationAgent(auth, nhiId);
  if (
    !selectedAgent ||
    (args.organizationId && selectedAgent.home_organization_id !== args.organizationId)
  )
    throw new Error('Agent not found in the selected authorized organization.');
  if (selectedAgent.version !== expectedVersion)
    throw new Error('The agent changed. Refresh agent list before retrying.');
  if (!args.apply) {
    const agent = await showManagedOrganizationAgent(auth, nhiId);
    if (!agent) throw new Error('Agent not found.');
    print({
      status: 'dry-run',
      operation: `agent.${args.action}`,
      nhi_id: nhiId,
      expected_version: expectedVersion,
      reason: args.reason,
      accountable_human_id: args.accountableHuman,
      note: 'Repeat with --apply to save.',
    });
    return;
  }
  print(
    args.action === 'reassign-accountable'
      ? await reassignManagedOrganizationAgentAccountable(auth, {
          nhiId,
          expectedVersion,
          accountableHumanId: requireText(args.accountableHuman, '--accountable-human'),
          reason: requireText(args.reason, '--reason'),
        })
      : await changeManagedOrganizationAgentLifecycle(auth, {
          nhiId,
          expectedVersion,
          action: args.action as 'activate' | 'suspend' | 'retire',
          reason: args.reason,
        })
  );
}
