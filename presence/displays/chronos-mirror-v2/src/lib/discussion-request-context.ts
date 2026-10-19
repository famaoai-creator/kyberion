import { createHash } from 'node:crypto';
import type { DiscussionRequestActor } from '@agent/core/discussion/discussion-create-request';
import type { DiscussionScope } from '@agent/core/discussion/discussion-types';
import {
  ViewerContextError,
  withViewerExecutionContext,
  type ViewerContext,
} from './viewer-context';

/** Authentication source and principal are server facts; a role is never identity. */
export function discussionRequestActor(viewer: ViewerContext): DiscussionRequestActor {
  if (!viewer.principalId || !['token', 'loopback'].includes(viewer.source))
    throw new ViewerContextError(403, 'An authenticated Discussion request identity is required.');
  return {
    principal_id: viewer.principalId,
    source: viewer.source as 'token' | 'loopback',
    ...(viewer.memberId ? { member_id: viewer.memberId } : {}),
  };
}

/** Called only after canonical scope resolution has authorized this tenant. */
export function withDiscussionRequestContext<T>(
  viewer: ViewerContext,
  scope: DiscussionScope,
  fn: () => T
): T {
  if (!scope.tenant_slug)
    throw new ViewerContextError(
      403,
      'Select an existing tenant or a tenant-bound confidential mission before creating or recovering a Discussion.'
    );
  return withViewerExecutionContext(
    scope.tenant_slug ? { ...viewer, tenantSlugs: [scope.tenant_slug] } : viewer,
    fn
  );
}

/** Bind absent fields too; routing is a selector, never proof of authorization. */
export function discussionRequestScopeDigest(scope: DiscussionScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        scope.tenant_slug ?? null,
        scope.organization_id ?? null,
        scope.project_id ?? null,
        scope.mission_id ?? null,
        scope.tier ?? 'confidential',
      ])
    )
    .digest('hex');
}
export function assertDiscussionRequestScopeDigest(value: unknown, scope: DiscussionScope): void {
  if (
    typeof value !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value) ||
    value !== discussionRequestScopeDigest(scope)
  )
    throw new ViewerContextError(
      403,
      'The original canonical scope changed or is unconfirmed. Keep the original request handle; do not resubmit.'
    );
}
