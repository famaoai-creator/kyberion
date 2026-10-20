import type { WorkspaceSelection } from './workspace-scope.js';

/** Navigation hints only: every server entry must authorize this selection. */
export function workspaceSelectionFromQuery(query: URLSearchParams): WorkspaceSelection {
  const read = (snake: string, camel?: string) =>
    query.get(snake) || (camel ? query.get(camel) : undefined) || undefined;
  return {
    ...(read('tenant', 'tenant_slug') ? { tenant_slug: read('tenant', 'tenant_slug') } : {}),
    ...(read('organization_id', 'organizationId')
      ? { organization_id: read('organization_id', 'organizationId') }
      : {}),
    ...(read('project_id', 'projectId') ? { project_id: read('project_id', 'projectId') } : {}),
    ...(read('operation_id', 'operationId')
      ? { operation_id: read('operation_id', 'operationId') }
      : {}),
    ...(query.get('tier') ? { tier: query.get('tier') as WorkspaceSelection['tier'] } : {}),
  };
}

export function workspaceQuery(
  selection: WorkspaceSelection,
  style: 'snake' | 'camel' = 'snake'
): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(selection)) {
    if (
      !value ||
      !['tenant_slug', 'organization_id', 'project_id', 'operation_id', 'tier'].includes(key)
    )
      continue;
    const name =
      key === 'tenant_slug'
        ? 'tenant'
        : style === 'camel'
          ? (
              {
                organization_id: 'organizationId',
                project_id: 'projectId',
                operation_id: 'operationId',
              } as Record<string, string>
            )[key] || key
          : key;
    query.set(name, value);
  }
  return query;
}

const ROW_SELECTORS = [
  'candidateKey',
  'request',
  'storageChannel',
  'mission',
  'mission_id',
  'missionId',
  'artifactId',
  'path',
  'sessionId',
];
/** Deliberate parent changes discard descendants and row identities, not navigation. */
export function changeWorkspaceSelection(
  query: URLSearchParams,
  key: 'tenant' | 'organization_id' | 'project_id' | 'operation_id',
  value: string
): URLSearchParams {
  const next = new URLSearchParams(query);
  const canonical = workspaceQuery(workspaceSelectionFromQuery(query));
  for (const name of ['tenant_slug', 'organizationId', 'projectId', 'operationId'])
    next.delete(name);
  for (const [name, selected] of canonical) next.set(name, selected);
  if ((next.get(key) || '') === value) return next;
  if (
    key === 'tenant' ||
    key === 'organization_id' ||
    (key === 'project_id' && !value && !next.get('organization_id'))
  )
    next.delete('tier');
  for (const name of ROW_SELECTORS) next.delete(name);
  const descendants =
    key === 'tenant'
      ? ['organization_id', 'project_id', 'operation_id']
      : key === 'organization_id'
        ? ['project_id', 'operation_id']
        : key === 'project_id'
          ? ['operation_id']
          : ['project_id'];
  for (const name of descendants) next.delete(name);
  if (value) next.set(key, value);
  else next.delete(key);
  return next;
}

export function workspaceSectionHref(section: string, selection: WorkspaceSelection): string {
  const query = workspaceQuery(selection);
  query.set('section', section);
  return '/?' + query.toString();
}
