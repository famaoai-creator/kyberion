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
import { agentActor } from '../actor.js';
import { inspectInstalledOnboardingRuntime } from '../organization/onboarding-runtime-identity.js';
import { withInstalledPersonCharterRuntime } from './person-charter-runtime.js';
export { withInstalledPersonCharterRuntime } from './person-charter-runtime.js';
import { findActiveCharter } from './accountability-charter-registry.js';
import type { CharterScope } from './accountability-charter.js';
import {
  parseExternalOperationGrant,
  externalOperationGrantMatches,
} from './external-operation-target.js';
export {
  parseExternalOperationGrant,
  parseExternalOperationGrants,
} from './external-operation-target.js';
export type { ExternalOperationGrant } from './external-operation-target.js';
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

/** The onboarding facade proves profile ownership and installed agent identity.
 * Caller action parameters cannot install this authority context. */
export function createOnboardingExternalOperationAuthority(options: {
  scope: CharterScope;
  agentId: string;
  ownerActor: string;
  invocationId: string;
  hasHuman?: false;
}): ExternalOperationAuthorityResolver {
  if (!options.invocationId.trim())
    throw new Error('[EXTERNAL_IDENTITY_REQUIRED] Stable invocation required');
  const scope = structuredClone(options.scope);
  return (facts) => {
    const authority = {
      agentId: options.agentId,
      invocationId: computeApprovalPayloadHash({
        base: options.invocationId,
        pipeline: externalOperationReplayKey('onboarding'),
        occurrence: currentExternalOperationOccurrence(),
      }),
      hasHuman: false,
      standingScope: scope,
      ...(scope.kind === 'organization' ? { tenantSlug: scope.tenant_slug } : {}),
    };
    // A destination grant never declassifies source content. Only a trusted
    // public execution scope may use these first, narrowly supported grants.
    const envelope = currentScopeEnvelope();
    const source = envelope?.identity ?? resolveScopeContext();
    if (source.nhi_id && source.nhi_id !== options.agentId)
      throw new Error(
        '[EXTERNAL_AGENT_IDENTITY_MISMATCH] Installed NHI differs from actual execution actor'
      );
    if (
      source.tier !== 'public' ||
      envelope?.policy.external_egress === 'deny' ||
      (envelope && !envelope.policy.read_tiers.includes('public'))
    )
      return authority;
    const charter = findActiveCharter(scope, new Date());
    if (!charter || !facts.delegable) return authority;
    const effect = facts.effect as Record<string, unknown>;
    let raw: unknown;
    if (facts.operationId === 'vcs:pr_create') {
      if (effect.body_source_tier !== 'public' && effect.body_source_tier !== 'inline')
        return authority;
      const repository = effect.repository as
        { url?: unknown; host?: unknown; slug?: unknown } | undefined;
      if (repository && typeof repository.url === 'string') {
        const url = new URL(repository.url);
        if (
          url.host === repository.host &&
          url.pathname.replace(/^\//, '').replace(/\/$/, '') === repository.slug
        )
          raw = {
            operation_id: facts.operationId,
            repository: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
          };
      }
    } else if (facts.operationId === 'browser:goto' || facts.operationId === 'browser:open_tab') {
      if (effect.navigation_confinement !== 'isolated-public-read-v1') return authority;
      const params = effect.params as { url?: unknown } | undefined;
      if (typeof params?.url === 'string') {
        const url = new URL(params.url);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash)
          raw = { operation_id: facts.operationId, origin: url.origin };
      }
    }
    const target = parseExternalOperationGrant(raw);
    if (
      !target ||
      !(charter.envelope.external_operations ?? []).some((grant) =>
        externalOperationGrantMatches(grant, target)
      )
    )
      return authority;
    return {
      ...authority,
      charter: {
        scope,
        action: {
          actor: agentActor(options.agentId, options.ownerActor),
          action_class: 'target_scoped_external_operation',
          external_operation: target,
          reversible: false,
          irreversible_action_name: target.operation_id,
          estimated_loss: 0,
          reputational_class: 'B' as const,
          blast_radius: { systems: 1, recipients: 1 },
        },
      },
    };
  };
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
  const run = () => {
    if (hasExternalOperationAuthority()) return dispatch();
    const identity = currentScopeEnvelope()?.identity ?? resolveScopeContext();
    const scope: CharterScope = identity.tenant_slug
      ? { kind: 'organization', tenant_slug: identity.tenant_slug }
      : { kind: 'person' };
    const installed = inspectInstalledOnboardingRuntime(scope);
    const base = createRuntimeExternalOperationAuthority(options);
    const onboard =
      installed.ready && 'agentActive' in installed && installed.agentActive === true
        ? createOnboardingExternalOperationAuthority({
            scope,
            agentId: installed.agentId,
            ownerActor: installed.ownerId,
            invocationId: options.runId || randomUUID(),
          })
        : undefined;
    const execute = () =>
      withExternalOperationAuthority((facts) => {
        if (!onboard) return base(facts);
        const target = onboard(facts);
        if (
          ['vcs:pr_create', 'browser:goto', 'browser:open_tab'].includes(facts.operationId) &&
          target?.charter
        )
          return target;
        // Preserve individual human approval and all existing Slack/meeting
        // delegation while carrying the independent installed standing stop.
        return { ...base(facts), standingScope: target?.standingScope };
      }, dispatch);
    return installed.ready &&
      'agentActive' in installed &&
      installed.agentActive === true &&
      scope.kind === 'person'
      ? withInstalledPersonCharterRuntime(
          { ownerActor: installed.ownerId, agentId: installed.agentId },
          execute
        )
      : execute();
  };
  return runtimeIdentity.run(Object.freeze({ ...options }), () =>
    options.runId ? withExternalOperationPipelineRun(options.runId, run) : run()
  );
}
