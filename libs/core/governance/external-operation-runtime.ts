/** Trusted pipeline dispatch adapter. Action JSON never supplies authority facts. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeContext } from '../scope-context.js';
import { computeApprovalPayloadHash } from './approval-store.js';
import { charterInputForDecision } from './charter-call-site.js';
import { currentExternalOperationOccurrence } from './external-operation-occurrence.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import { redactSensitiveValue } from '../network.js';
import {
  hasExternalOperationAuthority,
  withExternalOperationAuthority,
  withExternalOperationPipelineRun,
  type ExternalOperationAuthorityResolver,
} from './external-operation.js';

export interface ExternalOperationRuntimeOptions {
  runId?: string;
  stepId: string;
  hasHuman?: boolean;
}

const runtimeIdentity = new AsyncLocalStorage<Readonly<ExternalOperationRuntimeOptions>>();

/** Stable default identity for generated artifacts across approval resumption.
 * Only the trusted dispatch wrapper installs it; action JSON is never read. */
export function externalOperationReplayKey(namespace: string): string | undefined {
  const identity = runtimeIdentity.getStore();
  if (!identity?.runId) return undefined;
  const scope = currentScopeEnvelope()?.identity ?? resolveScopeContext();
  return computeApprovalPayloadHash({
    namespace,
    run: identity.runId,
    step: identity.stepId,
    tenant: scope.tenant_slug,
    tier: scope.tier,
    occurrence: currentExternalOperationOccurrence(),
  });
}

// Reviewed operation identities only. No regex inference from model action names.
const REPLY_OPERATIONS = new Set([
  'service:slack:preset:post_message',
  'meeting:speak',
  'meeting:chat',
]);

export function createRuntimeExternalOperationAuthority(
  options: ExternalOperationRuntimeOptions
): ExternalOperationAuthorityResolver {
  const scope = currentScopeEnvelope()?.identity ?? resolveScopeContext();
  const tenantSlug = scope.tenant_slug;
  const invocation = options.runId?.trim() || randomUUID();
  return (facts) => {
    // Destination distinguishes foreach sends; body edits retain the invocation
    // identity and are rejected by the execution receipt's payload binding.
    const rawParams = facts.effect.params;
    const params =
      rawParams && typeof rawParams === 'object' ? (rawParams as Record<string, unknown>) : {};
    const destination = {
      channel: params.channel,
      channel_id: params.channel_id,
      thread_ts: params.thread_ts,
      meeting_id: params.meeting_id,
      url: params.url,
    };
    const authority = {
      agentId: 'pipeline-external-worker',
      ...(tenantSlug ? { tenantSlug } : {}),
      invocationId: computeApprovalPayloadHash({
        run: invocation,
        step: options.stepId,
        operation: facts.operationId,
        destination,
        occurrence: currentExternalOperationOccurrence(),
      }),
      hasHuman: options.hasHuman === true,
      ...(options.runId
        ? {
            pipelineContext: {
              surface: 'system' as const,
              actorId: `pipeline:${options.runId}`,
              actorRole: 'pipeline',
              pipelineRunId: options.runId,
              stepId: options.stepId,
              ...(scope.mission_id ? { missionId: scope.mission_id } : {}),
            },
          }
        : {}),
      review: {
        summary: `Review pipeline external operation ${facts.operationId} at step ${options.stepId}`,
        artifactRefs: [] as string[],
      },
    };
    // Review references participate in the approval payload hash. Recreate the
    // same scoped reference on headless resume too; presence is not effect data.
    if (facts.requiresApproval && (authority.hasHuman || tenantSlug)) {
      if (!tenantSlug) {
        throw new Error(
          '[EXTERNAL_REVIEW_SCOPE_REQUIRED] Bind a tenant before creating an external-operation review'
        );
      }
      // Exact content stays inside the owning scope. Only this reference and
      // the original effect hash travel into the approval record/audit stream.
      const effectHash = computeApprovalPayloadHash(facts.effect);
      const review = writeScopedArtifact({
        scope: { tenant: tenantSlug },
        tier: scope.tier === 'personal' ? 'personal' : 'confidential',
        artifact_class: 'evidence',
        name: `external-operation-review/${authority.invocationId}-${effectHash}.json`,
        content: {
          operation_id: facts.operationId,
          invocation_id: authority.invocationId,
          effect_hash: effectHash,
          effect: redactSensitiveValue(facts.effect),
        },
      });
      authority.review.artifactRefs.push(review.repo_relative_path);
    }
    if (!tenantSlug || !facts.delegable || !REPLY_OPERATIONS.has(facts.operationId))
      return authority;
    const charter = charterInputForDecision({
      tenantSlug,
      agentId: authority.agentId,
      decisionType: 'external_reply',
      recipients: Number.MAX_SAFE_INTEGER,
      informationFlow: {
        purpose: facts.operationId.startsWith('meeting:')
          ? 'meeting_participation'
          : 'external_service_operation',
        recipient_class: 'unknown',
        categories: ['unknown'],
        attachment_count: 100,
      },
    });
    return {
      ...authority,
      ...(charter ? { charter } : {}),
    };
  };
}

/** Preserve the embedding runtime's stronger authority port when already bound. */
export function withRuntimeExternalOperationAuthority<T>(
  options: ExternalOperationRuntimeOptions,
  dispatch: () => T
): T {
  const run = () =>
    hasExternalOperationAuthority()
      ? dispatch()
      : withExternalOperationAuthority(createRuntimeExternalOperationAuthority(options), dispatch);
  return runtimeIdentity.run(Object.freeze({ ...options }), () =>
    options.runId ? withExternalOperationPipelineRun(options.runId, run) : run()
  );
}
