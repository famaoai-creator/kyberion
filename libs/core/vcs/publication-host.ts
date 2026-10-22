/** Explicit standalone VCS host: request human decisions without asserting presence. */
import { pathResolver } from '../path-resolver.js';
import { ghPrCreate, ghPrMerge } from './github.js';
import { gitPush, type VcsCommandResult, type VcsCommandRunner } from './git.js';
import { computeApprovalPayloadHash } from '../governance/approval-store.js';
import {
  ExternalOperationApprovalRequired,
  hasExternalOperationAuthority,
  withExternalOperationAuthority,
  withExplicitExternalApprovalRequest,
} from '../governance/external-operation.js';
import { withInstalledOnboardingAuthority } from '../organization/onboarding-authority-runtime.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { resolveScopeContext } from '../scope-context.js';
import { writeScopedArtifact } from '../workforce/artifact-store.js';
import { withExecutionContext } from '../authority.js';
import {
  withPrPublicationRuntime,
  withPrPublicationStoreAccess,
  PR_PUBLICATION_STORE_ROLE,
} from '../governance/pr-publication-runtime.js';

export type VcsHostMutation =
  | { operation: 'pr_create'; params: Parameters<typeof ghPrCreate>[0] }
  | { operation: 'pr_merge'; params: Parameters<typeof ghPrMerge>[0] }
  | {
      operation: 'push';
      params: { cwd: string; remote?: string; ref?: string; setUpstream?: boolean };
    };

export function vcsHostOperationId(
  operation: VcsHostMutation['operation']
): 'vcs:pr_create' | 'vcs:pr_merge' | 'vcs:push' {
  return `vcs:${operation}`;
}

/** Host intent key. The resolved typed effect is additionally bound at admission. */
export function vcsHostInvocationId(mutation: VcsHostMutation): string {
  const { cwd: _cwd, ...params } = mutation.params;
  const {
    env: _env,
    bodyFile: _bodyFile,
    ...withoutCredentials
  } = params as typeof params & { env?: unknown; bodyFile?: string };
  return computeApprovalPayloadHash({ operation: mutation.operation, params: withoutCredentials });
}

export function runVcsMutationWithApproval(
  mutation: VcsHostMutation,
  invocationId: string,
  print: (value: unknown) => void,
  runner?: VcsCommandRunner,
  options: { authority?: 'standalone' | 'existing_only' } = {}
): VcsCommandResult {
  const operationId = vcsHostOperationId(mutation.operation);
  const label = mutation.operation === 'pr_create' ? '[pr:publish]' : `[vcs:${mutation.operation}]`;
  const scope = currentScopeEnvelope()?.identity ?? resolveScopeContext();
  const standingScope = scope.tenant_slug
    ? { kind: 'organization' as const, tenant_slug: scope.tenant_slug }
    : { kind: 'person' as const };
  let review: ReturnType<typeof writeScopedArtifact> | undefined;
  const execute = (): VcsCommandResult => {
    if (mutation.operation === 'pr_create')
      return runner ? ghPrCreate(mutation.params, runner) : ghPrCreate(mutation.params);
    if (mutation.operation === 'pr_merge')
      return runner ? ghPrMerge(mutation.params, runner) : ghPrMerge(mutation.params);
    return runner
      ? gitPush(mutation.params.cwd, mutation.params, runner)
      : gitPush(mutation.params.cwd, mutation.params);
  };
  const withHostAuthority = (): VcsCommandResult => {
    if (options.authority === 'existing_only') return execute();
    return withInstalledOnboardingAuthority(
      invocationId,
      () => {
        if (hasExternalOperationAuthority()) return execute();
        return withExternalOperationAuthority(
          (facts) => ({
            agentId: 'vcs-publication-cli',
            invocationId: computeApprovalPayloadHash({
              invocationId,
              operation: facts.operationId,
              effect: facts.effect,
              scope,
            }),
            hasHuman: false,
            ...(scope.tenant_slug ? { tenantSlug: scope.tenant_slug } : {}),
            standingScope,
          }),
          execute
        );
      },
      { bindEffectIdentity: true }
    );
  };
  try {
    return withPrPublicationRuntime(
      standingScope,
      invocationId,
      () =>
        withExplicitExternalApprovalRequest(
          {
            operationId,
            requestScope: scope,
            reviewArtifacts: (effect) => {
              const floor = scope.tenant_slug
                ? `confidential/${scope.tenant_slug}`
                : 'personal/shared';
              const family =
                mutation.operation === 'pr_create' ? 'pr-publication' : 'vcs-publication';
              const name = `${family}/${invocationId}/${computeApprovalPayloadHash(effect)}.json`;
              const root = `active/shared/artifacts/${floor}`;
              const paths = [`${root}/evidence/${name}`, `${root}/artifacts-index.jsonl`];
              review = withPrPublicationStoreAccess('review-write', paths, paths, () =>
                withExecutionContext(
                  PR_PUBLICATION_STORE_ROLE,
                  () =>
                    writeScopedArtifact({
                      scope: { tenant: scope.tenant_slug ?? 'shared' },
                      tier: scope.tenant_slug ? 'confidential' : 'personal',
                      artifact_class: 'evidence',
                      name,
                      content: effect,
                    }),
                  'worker',
                  scope.tenant_slug
                )
              );
              return [review.repo_relative_path];
            },
          },
          withHostAuthority
        ),
      operationId
    );
  } catch (error) {
    if (error instanceof ExternalOperationApprovalRequired && error.approval.requestId) {
      print(`${label} Human decision required: ${error.approval.requestId}`);
      if (review) print(`${label} Review full publication: ${review.absolute_path}`);
      print(
        `${label} In a human terminal at ${pathResolver.rootDir()}: pnpm kyberion approvals --approve ${error.approval.requestId}`
      );
      print(
        `${label} After approval, rerun the same ${mutation.operation === 'pr_create' ? 'pr create' : mutation.operation} command. Changed source or review text requires a new decision.`
      );
    }
    throw error;
  }
}

/** Compatibility entry point used by governed PR publication. */
export function publishWithApproval(
  publication: Parameters<typeof ghPrCreate>[0],
  invocationId: string,
  print: (value: unknown) => void,
  runner?: VcsCommandRunner
): VcsCommandResult {
  return runVcsMutationWithApproval(
    { operation: 'pr_create', params: publication },
    invocationId,
    print,
    runner
  );
}
