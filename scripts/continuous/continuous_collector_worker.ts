/** Managed child entry for a reserved, scope-bound Collector Pipeline run. */
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRole } from '@agent/core/authority';
import { findDotCharter } from '@agent/core/dot/dot-charter';
import { runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { getOperationsHaltState } from '@agent/core/governance/operations-halt';
import { organizationCadenceLifecycle } from '@agent/core/organization/organization-cadence';
import { withReasoningPayloadScope } from '@agent/core/reasoning/reasoning-egress-scope';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveScopeResolution } from '@agent/core/scope-context';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import {
  executePipelineFile,
  isPipelineNotStartedError,
  pipelinePayloadTrainingUse,
} from '../run_pipeline.js';
import { isRegisteredContinuousWorker } from './continuous_owner_platform.js';
import { COLLECTOR_NOT_STARTED_EXIT, readCollectorAttempt } from './continuous_collector_state.js';

export async function runCollectorWorker(dotId: string, ref: string, runId: string): Promise<void> {
  const root = pathResolver.rootDir();
  const charter = findDotCharter(dotId, root)?.charter;
  const selected = resolveScopeResolution().scope;
  if (
    !charter ||
    charter.authority.authority_role !== resolveRole() ||
    charter.scope.tier !== selected.tier ||
    charter.scope.tenant_slug !== selected.tenant_slug ||
    charter.scope.organization_id !== selected.organization_id ||
    charter.scope.project_id !== selected.project_id ||
    !charter.scope.organization_id
  )
    throw new Error('Collector worker requires the exact charter execution scope');

  const { scope } = charter;
  await runAsDotCharter(charter, async () => {
    const assertCurrent = () => {
      const current = findDotCharter(dotId, root)?.charter;
      if (
        current?.status !== 'active' ||
        current.authority.authority_role !== charter.authority.authority_role ||
        !current.authority.allowed_pipelines?.includes(ref) ||
        current.scope.tier !== scope.tier ||
        current.scope.tenant_slug !== scope.tenant_slug ||
        current.scope.organization_id !== scope.organization_id ||
        current.scope.project_id !== scope.project_id ||
        current.scope.owner_nhi !== scope.owner_nhi ||
        getOperationsHaltState().halted ||
        organizationCadenceLifecycle(
          {
            organizationId: scope.organization_id!,
            tenantSlug: scope.tenant_slug,
            tier: scope.tier,
          },
          root
        ) !== 'active'
      )
        throw new Error('Collector worker authorization is no longer current');
      const attempt = readCollectorAttempt(root, charter, ref);
      if (
        attempt?.status !== 'unconfirmed' ||
        attempt.pipeline_run_id !== runId ||
        !attempt.containment ||
        !isRegisteredContinuousWorker(attempt.containment)
      )
        throw new Error('Collector worker requires the reserved Pipeline run');
    };
    // A parent that dies before publishing containment can never authorize effects.
    const reservationDeadline = Date.now() + 500;
    for (;;) {
      const reserved = readCollectorAttempt(root, charter, ref);
      if (
        reserved?.status !== 'unconfirmed' ||
        reserved.pipeline_run_id !== runId ||
        reserved.containment ||
        Date.now() >= reservationDeadline
      )
        break;
      await delay(25);
    }
    assertCurrent();
    const payloadScope = { tier: scope.tier, tenant_slug: scope.tenant_slug };
    const result = await withReasoningPayloadScope(
      {
        ...payloadScope,
        training_use: pipelinePayloadTrainingUse(scope.tier),
        purpose: `pipeline ${ref}`,
      },
      () =>
        executePipelineFile(ref, {
          context: {
            tier: scope.tier,
            tenant_slug: scope.tenant_slug,
            organization_id: scope.organization_id,
            project_id: scope.project_id,
            collector_attempt_id: runId,
          },
          payloadScope,
          hasHuman: false,
          quiet: true,
          journalRunId: runId,
          collectorExecution: { dot_id: dotId, attempt_id: runId },
          assertExecutionCurrent: assertCurrent,
        })
    );
    if (result.status !== 'succeeded' || result.results.some((step) => step.status === 'failed'))
      throw new Error('Continuous collector Pipeline did not succeed');
  });
}

if (
  isDirectScript(import.meta.url, 'continuous_collector_worker.js') ||
  isDirectScript(import.meta.url, 'continuous_collector_worker.ts')
) {
  void defineScript({
    name: 'continuous-collector-worker',
    flags: [],
    run: async ({ argv }) => {
      const [dotId, ref, runId] = argv;
      if (!dotId || !ref || !runId || argv.length !== 3)
        throw new Error('Collector worker requires a charter, Pipeline and reserved run ID');
      try {
        await runCollectorWorker(dotId, ref, runId);
      } catch (error) {
        if (isPipelineNotStartedError(error))
          throw new ScriptExitError(COLLECTOR_NOT_STARTED_EXIT, 'Collector Pipeline did not start');
        throw error;
      }
    },
  })();
}
