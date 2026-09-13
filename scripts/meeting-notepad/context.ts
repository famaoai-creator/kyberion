import { randomUUID } from 'node:crypto';
import { normalizeEventScope, type EventScope, type EventScopeKind } from '@agent/core/event-scope';

export interface MeetingNotepadContext {
  notepad_session_id: string;
  artifact_ref: string;
  viewer_principal: string;
  scope: EventScope;
}

export function createMeetingNotepadContext(input: {
  artifact_ref: string;
  viewer_principal: string;
  tier: 'public' | 'confidential' | 'personal';
  tenant_slug?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
}): MeetingNotepadContext {
  const artifactRef = input.artifact_ref.trim();
  if (!artifactRef) throw new Error('[NOTEPAD_SCOPE_REQUIRED] artifact_ref is required');
  const viewerPrincipal = input.viewer_principal.trim();
  if (!viewerPrincipal) throw new Error('[NOTEPAD_VIEWER_REQUIRED] viewer_principal is required');
  if (input.tier !== 'public' && !input.tenant_slug?.trim()) {
    throw new Error('[NOTEPAD_SCOPE_REQUIRED] confidential and personal notepads require a tenant');
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
    notepad_session_id: `mn-${randomUUID()}`,
    artifact_ref: artifactRef,
    viewer_principal: viewerPrincipal,
    scope,
  };
}

export function meetingNotepadReceiptLogicalPath(context: MeetingNotepadContext): string {
  const prefix = context.scope.tenant_slug
    ? `active/shared/observability/meeting-notepad/tenants/${context.scope.tenant_slug}`
    : 'active/shared/observability/meeting-notepad';
  return `${prefix}/receipts/${context.notepad_session_id}.json`;
}

export function meetingNotepadHandoffLogicalPath(outDir: string): string {
  return `${outDir.replace(/\/$/, '')}/handoff.json`;
}

export function meetingNotepadSessionDir(outDir: string, sessionId: string): string {
  return `${outDir.replace(/\/$/, '')}/sessions/${sessionId}`;
}
