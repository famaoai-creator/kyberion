import { changeWorkspaceSelection } from '@agent/core/surface/workspace-query';

/**
 * The rail's project selector. A project narrows the selected company; it
 * travels only as the page URL's `organization_id` + `project_id` (no
 * cookie), so a shared link reopens the same view and a fresh visit starts
 * from every project. The server treats both values as narrowing hints only:
 * outside the viewer's scope they are refused (403), never widened.
 */

/** What `/api/me` offers for the selected company (`lib/selected-project.ts`). */
export interface SelectableProject {
  project_id: string;
  name: string;
  organization_id: string;
}

/** Selector value for "every project of this company". */
export const ALL_PROJECTS = '';

/**
 * Pure. The URL `project_id` is honoured only when it names an offered project
 * (and, when an `organization_id` is given too, that project's organization).
 */
export function resolveSelectedProject(
  hint: { project_id?: string | null; organization_id?: string | null },
  projects: readonly SelectableProject[]
): SelectableProject | null {
  const projectId = hint.project_id?.trim();
  if (!projectId) return null;
  const organizationId = hint.organization_id?.trim();
  return (
    projects.find(
      (project) =>
        project.project_id === projectId &&
        (!organizationId || project.organization_id === organizationId)
    ) ?? null
  );
}

/** Reads the project hint from a query string (snake or camel case). */
export function projectHintFromQuery(query: URLSearchParams): {
  project_id: string | null;
  organization_id: string | null;
} {
  return {
    project_id: query.get('project_id') || query.get('projectId'),
    organization_id: query.get('organization_id') || query.get('organizationId'),
  };
}

/**
 * Pure. The same page narrowed to `project` (organization + project), or —
 * for `null` — back to every project of the company. Row selections and the
 * operation are dropped, as for any parent change.
 */
export function projectSwitchHref(href: string, project: SelectableProject | null): string {
  const url = new URL(href);
  let query = changeWorkspaceSelection(url.searchParams, 'organization_id', '');
  if (project) {
    query = changeWorkspaceSelection(query, 'organization_id', project.organization_id);
    query = changeWorkspaceSelection(query, 'project_id', project.project_id);
  }
  url.search = query.toString();
  return url.pathname + url.search + url.hash;
}

/**
 * Pure. `path` with the page's project narrowing (`organization_id`,
 * `project_id`) copied from `pageSearch`, for API reads that do not see the
 * page URL. Without a project in the page URL the path is unchanged.
 */
export function withProjectScope(path: string, pageSearch: string): string {
  const hint = projectHintFromQuery(new URLSearchParams(pageSearch));
  if (!hint.project_id) return path;
  const [base, query = ''] = path.split('?', 2);
  const params = new URLSearchParams(query);
  params.set('project_id', hint.project_id);
  if (hint.organization_id) params.set('organization_id', hint.organization_id);
  return `${base}?${params.toString()}`;
}

/** Browser-only: `withProjectScope` against the current page URL. */
export function withPageProjectScope(path: string): string {
  if (typeof window === 'undefined') return path;
  return withProjectScope(path, window.location.search);
}
