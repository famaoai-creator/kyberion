import { findMissionPath } from '@agent/core/path-resolver';
import { missionPathOrNull } from '@agent/core/mission-lookup';
import { loadState } from '@agent/core/mission/mission-state';
import { loadArtifactRecord } from '@agent/core/workforce/artifact-record';
import { assertMemoryScope, type MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';
import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import {
  workspaceScopeMatchesResource,
  type ResolvedWorkspaceScope,
  type WorkspaceSelection,
} from '@agent/core/surface/workspace-scope';
import { memoryCandidateVisibleToViewer as memoryCandidateVisibleToViewerRule } from '../memory-candidate-visibility';
import type { ViewerContext } from './ops-viewer';

function sourceScope(candidate: MemoryCandidate): MemoryScopeEnvelope | null {
  try {
    if (candidate.scope) return assertMemoryScope(candidate.scope);
    const sourceRef = String(candidate.source_ref || '').trim();
    const [, rawRef = ''] = sourceRef.split(':', 2);
    if (candidate.source_type === 'artifact') {
      const artifact = loadArtifactRecord(rawRef || sourceRef);
      if (artifact)
        return {
          tier: candidate.sensitivity_tier,
          tenant_slug: artifact.tenant_slug,
          organization_id: artifact.organization_id,
          project_id: artifact.project_id,
        };
    }
    if (candidate.source_type === 'mission') {
      const missionId = rawRef || sourceRef;
      if (!missionPathOrNull(findMissionPath, missionId)) return null;
      const state = loadState(missionId);
      if (state)
        return {
          tier: state.tier,
          tenant_slug: state.tenant_slug || state.tenant_id,
          organization_id:
            state.organization_id || state.relationships?.organization?.organization_id,
          project_id: state.relationships?.project?.project_id,
        };
    }
    return { tier: candidate.sensitivity_tier };
  } catch {
    return null;
  }
}

export function resolveMemoryCandidateTenant(candidate: MemoryCandidate): string | undefined {
  return sourceScope(candidate)?.tenant_slug;
}

/**
 * The shared visibility rule (`../memory-candidate-visibility`) with the
 * console's source scope: a row recorded without a scope takes it from its
 * mission / artifact record, and an unresolvable source hides the row.
 */
export function memoryCandidateVisibleToViewer(
  candidate: MemoryCandidate,
  viewer: ViewerContext,
  requestedTenant?: string
): boolean {
  return memoryCandidateVisibleToViewerRule(candidate, viewer, {
    requestedTenant,
    sourceScope: sourceScope(candidate),
  });
}

/** Canonical knowledge path namespaces carry storage scope, not URL selectors. */
export function knowledgeDocumentVisibleToWorkspace(
  documentPath: string,
  workspace: ResolvedWorkspaceScope
): boolean {
  const segments = documentPath.split('/');
  if (
    segments[0] !== 'knowledge' ||
    !['public', 'confidential', 'personal'].includes(segments[1]) ||
    segments.some((value) => value === '..' || value === '.')
  )
    return false;
  const resource: WorkspaceSelection = { tier: segments[1] as WorkspaceSelection['tier'] };
  let offset = 2;
  if (resource.tier === 'confidential') {
    resource.tenant_slug = segments[2];
    offset = 3;
  }
  if (segments[offset] === 'organizations') {
    resource.organization_id = segments[offset + 1];
    offset += 2;
  }
  if (segments[offset] === 'projects') resource.project_id = segments[offset + 1];
  const inherited = workspace.selection.operation_id
    ? {
        ...workspace,
        selection: {
          ...workspace.selection,
          operation_id: undefined,
          kind: 'organization' as const,
        },
      }
    : workspace;
  return workspaceScopeMatchesResource(inherited, resource);
}
