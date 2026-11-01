import { withExecutionContextAsync } from '@agent/core/authority';
import { credentialExecutionIdentity } from '@agent/core/foundation/credential-binding';
import {
  requireReasoningApiProvider,
  isReasoningApiModel,
} from '@agent/core/reasoning/reasoning-api-credentials';
import {
  listCredentialAllocations,
  assertCredentialAllocation,
  installLocalCredentialAllocations,
} from '@agent/core/secret/credential-allocations';
const denied = () => new Error('[CREDENTIAL_ALLOCATION_DENIED] No usable local allocation');

/** A real diagnostic WorkItem: normal claim/envelope/binding path, synthetic public input only. */
export async function probeAllocatedCredential(options: {
  tenant: string;
  provider: string;
  mission: string;
  model: string;
  allowPaid: boolean;
}) {
  if (!options.allowPaid) throw new Error('Tenant probe requires --allow-paid.');
  if (!isReasoningApiModel(options.model)) throw new Error('An explicit valid model is required.');
  const provider = requireReasoningApiProvider(options.provider).mode;
  const outer = credentialExecutionIdentity();
  if (outer.tenantSlug && outer.tenantSlug !== options.tenant) throw denied();
  const { randomUUID } = await import('node:crypto');
  const task = `credential-probe-${randomUUID()}`;
  return withExecutionContextAsync(
    'credential_allocation_probe',
    async () => {
      const { getSecretResolver, installSecretResolverIfAvailable } =
        await import('@agent/core/secret/secret-resolver');
      installSecretResolverIfAvailable();
      installLocalCredentialAllocations();
      if (getSecretResolver()?.name === 'local-credential-allocations') {
        const active = listCredentialAllocations(options.tenant).some((g) => {
          try {
            assertCredentialAllocation(options.tenant, g.grant_id, provider);
            return true;
          } catch {
            return false;
          }
        });
        if (!active) throw denied();
      }
      const { missionDir } = await import('@agent/core/path-resolver');
      const { readMissionStateAtPath } = await import('@agent/core/mission/mission-state-reader');
      const mission = readMissionStateAtPath(
        `${missionDir(options.mission, 'confidential', options.tenant)}/mission-state.json`
      );
      if (
        mission.tenant_slug !== options.tenant ||
        mission.mission_id !== options.mission ||
        mission.status !== 'active'
      )
        throw new Error('Probe requires an active mission in the selected tenant.');
      const organization =
        mission.relationships?.organization?.organization_id ?? mission.organization_id;
      const project = mission.relationships?.project?.project_id;
      if (!organization || !project)
        throw new Error(
          'Probe requires a mission linked to an organization and project; use mission kickoff --organization-id and --project-id.'
        );
      const { createWorkItem } = await import('@agent/core/workforce/work-coordination');
      const { delegateCoordinatedCliSubagentTask } =
        await import('@agent/core/coordinated-agent-execution-port');
      const { verifyReasoningApiCredential } =
        await import('@agent/core/reasoning/reasoning-api-credentials');
      const { currentScopeEnvelope, mintScopeEnvelope, withScopeEnvelope } =
        await import('@agent/core/scope-envelope');
      if (currentScopeEnvelope())
        throw new Error('Start a diagnostic probe outside an existing task envelope.');
      const context = {
        tenant_slug: options.tenant,
        mission_id: options.mission,
        task_id: task,
        organization_id: organization,
        project_id: project,
        work_shape: 'improvement_experiment' as const,
      };
      const envelope = mintScopeEnvelope({
        identity: context,
        env: {
          KYBERION_TIER: 'confidential',
          KYBERION_TENANT: options.tenant,
          MISSION_ID: options.mission,
          KYBERION_TASK_ID: task,
        },
        policy: {
          read_tiers: ['public', 'confidential'],
          write_tier: 'confidential',
          purpose: 'Synthetic allocated API credential verification',
          allowed_reasoning_backends: [provider],
        },
      });
      return withScopeEnvelope(envelope, async () => {
        const item = createWorkItem({
          title: `Credential probe: ${provider}`,
          description: 'One bounded synthetic API proof using allocated task credentials.',
          sourceRef: 'reasoning-credentials:probe',
          status: 'ready',
          projectId: project,
          context,
        });
        const actor = `kyberion://agent/${options.tenant}/credential-probe`;
        let proof: Awaited<ReturnType<typeof verifyReasoningApiCredential>> | undefined;
        const receipt = await delegateCoordinatedCliSubagentTask(
          {
            work_item_id: item.item_id,
            task_id: task,
            mission_id: options.mission,
            instruction: 'Verify the allocated credential using one synthetic public prompt.',
            idempotency_key: task,
            security_scope: {
              ...context,
              read_tiers: ['public', 'confidential'],
              write_tier: 'confidential',
              purpose: 'Synthetic allocated API credential verification',
              allowed_reasoning_backends: [provider],
            },
          },
          async () => {
            proof = await verifyReasoningApiCredential({
              provider,
              model: options.model,
              allowPaid: true,
            });
            return {
              execution_kind: 'agent_delegation',
              task_id: task,
              agent_id: actor,
              status: proof.status === 'success' ? 'succeeded' : 'failed',
              output: JSON.stringify(proof),
            };
          },
          actor
        );
        return { work_item_id: item.item_id, task_id: task, status: receipt.status, proof };
      });
    },
    undefined,
    options.tenant,
    undefined,
    { missionId: options.mission, taskId: task }
  );
}
