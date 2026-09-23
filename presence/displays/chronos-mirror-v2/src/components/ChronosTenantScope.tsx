'use client';

import * as React from 'react';
import { Building2, ShieldCheck } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';
import {
  normalizeChronosTenantScopePayload,
  type ChronosOrganizationOption,
  type ChronosProjectOption,
  type ChronosTenantOption,
} from './tenant-scope-data';

export function useChronosTenant(): string {
  return useSearchParams().get('tenant') || '';
}

export function useChronosOrganization(): string {
  return useSearchParams().get('organization_id') || '';
}

export function useChronosProject(): string {
  return useSearchParams().get('project_id') || '';
}

export function ChronosTenantScope({ compact = false }: { compact?: boolean }) {
  const locale = useChronosLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tenants, setTenants] = React.useState<ChronosTenantOption[]>([]);
  const [organizations, setOrganizations] = React.useState<ChronosOrganizationOption[]>([]);
  const [projects, setProjects] = React.useState<ChronosProjectOption[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const selected = searchParams.get('tenant') || '';
  const selectedOrganization = searchParams.get('organization_id') || '';
  const selectedProject = searchParams.get('project_id') || '';

  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (selected) params.set('tenant', selected);
    if (selectedOrganization) params.set('organization_id', selectedOrganization);
    if (selectedProject) params.set('project_id', selectedProject);
    void fetch(`/api/tenant-scope${params.size ? `?${params.toString()}` : ''}`, {
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('tenant scope request failed');
        return response.json().catch(() => null);
      })
      .then((payload: unknown) => {
        const normalized = normalizeChronosTenantScopePayload(payload);
        if (!cancelled && normalized) {
          setTenants(normalized.tenants);
          setOrganizations(normalized.organizations);
          setProjects(normalized.projects);
          setLoadError(null);
        } else if (!cancelled) {
          setLoadError(uxText('chronos_tenant_scope_unavailable', locale));
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(uxText('chronos_tenant_scope_unavailable', locale));
      });
    return () => {
      cancelled = true;
    };
  }, [locale, selected, selectedOrganization, selectedProject]);

  const updateScope = (key: 'tenant' | 'organization_id' | 'project_id', value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    if (key === 'tenant') {
      params.delete('organization_id');
      params.delete('project_id');
    } else if (key === 'organization_id') {
      params.delete('project_id');
    }
    router.replace(`${pathname}${params.size ? `?${params.toString()}` : ''}`, { scroll: false });
  };

  // UI-07: a compact one-line scope bar in the page header. The choices are
  // only a narrowing hint — /api/tenant-scope and every data route resolve
  // the viewer's allowed scope server-side.
  return (
    <div
      className="chronos-scope"
      role="group"
      aria-label={uxText('chronos_tenant_scope_label', locale)}
    >
      <span className="chronos-scope__label">
        <Building2 size={13} aria-hidden="true" />
        {compact ? uxText('chronos_tenant_scope_label', locale) : uxText('chronos_scope', locale)}
      </span>
      <select
        aria-label={uxText('chronos_tenant_scope_label', locale)}
        value={selected}
        onChange={(event) => updateScope('tenant', event.target.value)}
        className="chronos-scope__select"
      >
        <option value="">{uxText('chronos_all_tenants', locale)}</option>
        {tenants.map((tenant) => (
          <option key={tenant.slug} value={tenant.slug}>
            {tenant.displayName}
          </option>
        ))}
      </select>
      <span className="chronos-scope__sep" aria-hidden="true">
        ›
      </span>
      <select
        aria-label={uxText('chronos_organization_scope_label', locale)}
        value={selectedOrganization}
        onChange={(event) => updateScope('organization_id', event.target.value)}
        className="chronos-scope__select"
      >
        <option value="">{uxText('chronos_all_organizations', locale)}</option>
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.id}
          </option>
        ))}
      </select>
      <span className="chronos-scope__sep" aria-hidden="true">
        ›
      </span>
      <select
        aria-label={uxText('chronos_project_scope_label', locale)}
        value={selectedProject}
        onChange={(event) => updateScope('project_id', event.target.value)}
        className="chronos-scope__select"
      >
        <option value="">{uxText('chronos_all_projects', locale)}</option>
        {projects
          .filter(
            (project) => !selectedOrganization || project.organization_id === selectedOrganization
          )
          .map((project) => (
            <option key={project.id} value={project.id}>
              {project.name || project.id}
            </option>
          ))}
      </select>
      <span className="chronos-scope__note">
        <ShieldCheck size={11} aria-hidden="true" />
        {uxText('chronos_scope_server_authorized', locale)}
      </span>
      {loadError ? <span className="chronos-scope__error">{loadError}</span> : null}
    </div>
  );
}
