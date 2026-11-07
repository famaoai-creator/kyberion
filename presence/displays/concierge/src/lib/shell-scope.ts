'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { readSelectedTenant } from './tenant-context';

/**
 * MSN-SHELL-IA §1 — the one scope a page reads: the shell's switcher writes
 * `?tenant=` (and the selection cookie); hierarchy deep links may add
 * organization / project in either query style. Pages pass this to their
 * APIs as a narrowing hint only — the server resolves the viewer and its
 * allowed scope on every request, so this can never widen access.
 */
export interface ShellScope {
  tenant: string;
  organizationId: string;
  projectId: string;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function shellScopeFromQuery(
  params: URLSearchParams,
  fallbackTenant: string | null = null
): ShellScope {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = params.get(key)?.trim();
      if (value && SLUG.test(value)) return value;
    }
    return '';
  };
  const tenant = pick('tenant', 'tenant_slug');
  return {
    tenant: tenant || (fallbackTenant && SLUG.test(fallbackTenant) ? fallbackTenant : ''),
    organizationId: pick('organizationId', 'organization_id'),
    projectId: pick('projectId', 'project_id'),
  };
}

export function useShellScope(): ShellScope {
  const searchParams = useSearchParams();
  const [fallback, setFallback] = React.useState<string | null>(null);
  // The cookie is read after mount so server and first client render agree.
  React.useEffect(() => setFallback(readSelectedTenant()), [searchParams]);
  return React.useMemo(
    () => shellScopeFromQuery(new URLSearchParams(searchParams?.toString() ?? ''), fallback),
    [searchParams, fallback]
  );
}

/**
 * Tab hrefs for a destination page: `?tab=` changes, the scope and other
 * page-wide parameters stay, list-local filters (`q`, `status`, `view`) and
 * the opened request (`request`) reset, and the default tab drops the
 * parameter.
 */
export function destinationTabHref(
  pathname: string,
  current: URLSearchParams,
  tab: string,
  defaultTab: string
): string {
  const next = new URLSearchParams(current);
  for (const key of ['tab', 'q', 'status', 'view', 'section', 'request']) next.delete(key);
  if (tab !== defaultTab) next.set('tab', tab);
  const query = next.toString();
  return `${pathname}${query ? `?${query}` : ''}`;
}
