/**
 * MSN-SHELL-IA-20261105 §1 — the seven top-level destinations and the
 * permanent (308) redirects from the routes they replaced.
 *
 * Pure: `resolveIaRedirect` maps a request path + query to the new location
 * (or null), and `proxy.ts` answers with a 308 before any auth decision, so a
 * bookmark lands on the new page and the new page re-checks the viewer. The
 * redirect carries the original query (minus the retired `section`), so a
 * tenant / scope narrowing survives the move. Redirects never grant anything.
 *
 * Detail pages `/w/<kind>/<id>` stay where they are.
 */

export type IaWorkTab = 'missions' | 'items';
export type IaOrgTab = 'overview' | 'projects' | 'people';
export type IaLibraryTab = 'deliverables' | 'knowledge' | 'ingest';

export const IA_WORK_TABS: readonly IaWorkTab[] = ['missions', 'items'];
export const IA_ORG_TABS: readonly IaOrgTab[] = ['overview', 'projects', 'people'];
export const IA_LIBRARY_TABS: readonly IaLibraryTab[] = ['deliverables', 'knowledge', 'ingest'];

/** `?tab=` value, falling back to the first (default) tab for anything unknown. */
export function resolveIaTab<T extends string>(tabs: readonly T[], value: string | null): T {
  return tabs.includes(value as T) ? (value as T) : tabs[0];
}

/** `/w/<kind>` list pages → their new home (target path + fixed query). */
const WORKSPACE_LIST_TARGETS: Readonly<Record<string, string>> = {
  mission: '/work',
  task: '/work',
  work_item: '/work?tab=items',
  approval: '/inbox',
  tenant: '/org',
  organization: '/org',
  project: '/org?tab=projects',
  actor: '/org?tab=people',
};

/** Retired `/ops?section=` values → their new home. Remaining sections stay on /ops. */
const OPS_SECTION_TARGETS: Readonly<Record<string, string>> = {
  home: '/',
  missions: '/work',
  'work-items': '/work?tab=items',
  approvals: '/inbox',
  governance: '/inbox',
  organization: '/org',
  deliverables: '/library',
  knowledge: '/library?tab=knowledge',
};

/** Sections `/ops` still renders (operations only). */
export const OPS_REMAINING_SECTIONS = [
  'operations',
  'surface-control',
  'diagnostics',
  'discussion',
] as const;

/** Exact-path redirects. */
const PATH_TARGETS: Readonly<Record<string, string>> = {
  '/w': '/',
  '/ingest': '/library?tab=ingest',
  '/setup': '/settings',
};

/** The new-route href for a workspace list kind (in-app links use this, not `/w/<kind>`). */
export function iaListHref(kind: string): string | null {
  return WORKSPACE_LIST_TARGETS[kind] ?? null;
}

/**
 * Merge the target's fixed query with the request's query. The target wins
 * on conflicts (it names the tab); `drop` keys (the retired `section`) are
 * removed.
 */
function withQuery(target: string, search: URLSearchParams, drop: readonly string[]): string {
  const [path, fixed = ''] = target.split('?');
  const merged = new URLSearchParams();
  for (const [key, value] of search) {
    if (!drop.includes(key)) merged.append(key, value);
  }
  for (const [key, value] of new URLSearchParams(fixed)) merged.set(key, value);
  const query = merged.toString();
  return `${path}${query ? `?${query}` : ''}`;
}

/**
 * Where a retired route now lives, as a same-origin path + query, or null when
 * the request is not a retired route. `pathname` is the request path;
 * `search` is its query string (with or without the leading `?`).
 */
export function resolveIaRedirect(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const fixed = PATH_TARGETS[path];
  if (fixed) return withQuery(fixed, params, []);
  const list = /^\/w\/([a-z_]+)$/.exec(path);
  if (list) {
    const target = WORKSPACE_LIST_TARGETS[list[1]];
    return target ? withQuery(target, params, []) : null;
  }
  if (path === '/ops') {
    const section = params.get('section');
    // A focused mission deep link opens its detail page rather than the list.
    const mission = params.get('mission')?.trim();
    if (section === 'missions' && mission && /^[A-Za-z0-9._:-]{1,200}$/.test(mission)) {
      return withQuery(`/w/mission/${encodeURIComponent(mission)}`, params, ['section', 'mission']);
    }
    const target = section ? OPS_SECTION_TARGETS[section] : undefined;
    return target ? withQuery(target, params, ['section']) : null;
  }
  return null;
}
