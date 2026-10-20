import {
  resolveWorkspaceScope,
  type ResolvedWorkspaceScope,
  type WorkspaceSelection,
} from '@agent/core/surface/workspace-scope';
import { withViewerExecutionContext, type ViewerContext } from './viewer-context';

export function workspaceSelectionFromSearchParams(search: URLSearchParams): WorkspaceSelection {
  const result: WorkspaceSelection = {};
  for (const [field, target] of [
    ['tenant', 'tenant_slug'],
    ['organization_id', 'organization_id'],
    ['project_id', 'project_id'],
    ['operation_id', 'operation_id'],
    ['tier', 'tier'],
  ] as const) {
    if (search.getAll(field).length > 1) throw new Error('Ambiguous workspace selection');
    const value = search.get(field);
    if (value !== null) Object.assign(result, { [target]: value });
  }
  return result;
}
export function resolveChronosWorkspace(
  viewer: ViewerContext,
  selection: WorkspaceSelection
): ResolvedWorkspaceScope {
  return withViewerExecutionContext(viewer, () =>
    resolveWorkspaceScope(
      {
        ...viewer,
        organizationIds: viewer.organizationIds ?? 'all',
        projectIds: viewer.projectIds ?? 'all',
        tierAccess: viewer.tierAccess ?? ['public', 'confidential'],
      },
      selection
    )
  );
}
