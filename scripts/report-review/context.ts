import { randomUUID } from 'node:crypto';
import { normalizeEventScope, type EventScope, type EventScopeKind } from '@agent/core';

export interface ReportReviewContext {
  review_session_id: string;
  artifact_ref: string;
  viewer_principal: string;
  scope: EventScope;
}

export function createReportReviewContext(input: {
  artifact_ref: string;
  viewer_principal: string;
  tier: 'public' | 'confidential' | 'personal';
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
}): ReportReviewContext {
  const artifactRef = input.artifact_ref.trim();
  if (!artifactRef) throw new Error('[REVIEW_SCOPE_REQUIRED] artifact_ref is required');
  const viewerPrincipal = input.viewer_principal.trim();
  if (!viewerPrincipal) throw new Error('[REVIEW_VIEWER_REQUIRED] viewer_principal is required');
  if (input.tier !== 'public' && !input.tenant_slug?.trim()) {
    throw new Error('[REVIEW_SCOPE_REQUIRED] confidential and personal reviews require a tenant');
  }
  const scopeKind: EventScopeKind = input.mission_id
    ? 'mission'
    : input.project_id
      ? 'project'
      : input.organization_id
        ? 'organization'
        : input.tenant_slug
          ? 'tenant'
          : 'system';
  const scope = normalizeEventScope({
    scope_kind: scopeKind,
    tier: input.tier,
    ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
    ...(input.organization_id ? { organization_id: input.organization_id } : {}),
    ...(input.project_id ? { project_id: input.project_id } : {}),
    ...(input.mission_id ? { mission_id: input.mission_id } : {}),
  });
  return {
    review_session_id: `rr-${randomUUID()}`,
    artifact_ref: artifactRef,
    viewer_principal: viewerPrincipal,
    scope,
  };
}

export function reviewReceiptLogicalPath(context: ReportReviewContext): string {
  const prefix = context.scope.tenant_slug
    ? `active/shared/observability/review-service/tenants/${context.scope.tenant_slug}`
    : 'active/shared/observability/review-service';
  return `${prefix}/receipts/${context.review_session_id}.json`;
}
