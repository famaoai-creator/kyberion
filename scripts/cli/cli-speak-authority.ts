import {
  ExternalOperationApprovalRequired,
  ExternalOperationOutcomeUnverified,
  hasExternalOperationAuthority,
  withExplicitExternalApprovalRequests,
  withExternalOperationAuthority,
  withExternalOperationApprovalObserver,
} from '@agent/core/governance/external-operation';
import { computeApprovalPayloadHash } from '@agent/core/governance/approval-presentation';
import { withInstalledOnboardingAuthority } from '@agent/core/organization/onboarding-authority-runtime';
import { currentScopeEnvelope } from '@agent/core/scope-envelope';
import { resolveScopeContext } from '@agent/core/scope-context';
import { writeScopedArtifact } from '@agent/core/workforce/artifact-store';

/** Direct CLI host for the audible effects reachable from local TTS. */
export async function runAudibleSpeak<T>(
  invocation: string,
  input: Record<string, unknown>,
  execute: () => Promise<T>
): Promise<T> {
  if (hasExternalOperationAuthority()) return execute();

  const scope = currentScopeEnvelope()?.identity ?? resolveScopeContext();
  const standingScope = scope.tenant_slug
    ? { kind: 'organization' as const, tenant_slug: scope.tenant_slug }
    : { kind: 'person' as const };
  const runId = computeApprovalPayloadHash({ invocation, scope, input });
  const request = (operationId: 'voice:speak' | 'voice:playback') => ({
    operationId,
    requestScope: scope,
    reviewArtifacts(effect: Record<string, unknown>): string[] {
      const effectHash = computeApprovalPayloadHash(effect);
      const params = effect.params as Record<string, unknown> | undefined;
      const target = Object.fromEntries(
        ['platform', 'format', 'backend', 'content_hash', 'device_name']
          .filter((key) => typeof params?.[key] === 'string')
          .map((key) => [key, params![key]])
      );
      const artifact = writeScopedArtifact({
        scope: {
          tenant: scope.tenant_slug ?? 'shared',
          ...(scope.project_id
            ? { project: scope.project_id }
            : scope.organization_id
              ? { organization: scope.organization_id }
              : {}),
        },
        tier: scope.tier,
        artifact_class: 'evidence',
        create_only: true,
        reuse_identical: true,
        name: `voice-playback-review/${operationId === 'voice:speak' ? 'speech' : 'audio'}-${runId}-${effectHash}.json`,
        content: {
          operation_id: operationId,
          invocation_id: invocation,
          effect_hash: effectHash,
          // The request binds the exact text and options without persisting the transcript.
          input_hash: computeApprovalPayloadHash(input),
          target,
        },
      });
      return [artifact.repo_relative_path];
    },
  });
  let unverified: string | undefined;
  try {
    const result = await withExternalOperationApprovalObserver(
      ({ approval, executionUnverified }) => {
        if (executionUnverified) unverified = approval.message;
      },
      () =>
        withExplicitExternalApprovalRequests(
          [request('voice:speak'), request('voice:playback')],
          () =>
            withInstalledOnboardingAuthority(
              runId,
              () => {
                if (hasExternalOperationAuthority()) return execute();
                return withExternalOperationAuthority((facts) => {
                  if (facts.operationId !== 'voice:speak' && facts.operationId !== 'voice:playback')
                    return undefined;
                  return {
                    agentId: 'voice-speak-cli',
                    invocationId: computeApprovalPayloadHash({
                      runId,
                      operation: facts.operationId,
                      effect: facts.effect,
                    }),
                    ...(scope.tenant_slug ? { tenantSlug: scope.tenant_slug } : {}),
                    standingScope,
                    hasHuman: false,
                  };
                }, execute);
              },
              { bindEffectIdentity: true }
            )
        )
    );
    if (unverified) throw new Error(unverified);
    return result;
  } catch (error) {
    if (unverified || error instanceof ExternalOperationOutcomeUnverified) {
      throw new Error(
        `${unverified || (error instanceof Error ? error.message : String(error))}\nNext: verify the previous playback result before retrying.`,
        {
          cause: error,
        }
      );
    }
    if (error instanceof ExternalOperationApprovalRequired) {
      const { requestId, requestStatus } = error.approval;
      const next =
        requestId && (!requestStatus || requestStatus === 'created' || requestStatus === 'pending')
          ? `Review approval ${requestId}. After approval, rerun the same speak command with --invocation-id ${invocation}.`
          : requestStatus === 'expired' ||
              requestStatus === 'rejected' ||
              requestStatus === 'effect_mismatch'
            ? 'Review the previous decision before starting a new invocation.'
            : undefined;
      if (next) throw new Error(`${error.message}\nNext: ${next}`, { cause: error });
    }
    throw error;
  }
}
