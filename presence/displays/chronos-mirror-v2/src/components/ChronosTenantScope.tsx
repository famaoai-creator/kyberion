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

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border kb-border-accent kb-surface-accent px-3 py-2">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] kb-text-accent">
        <Building2 size={13} />
        <span>
          {compact ? uxText('chronos_tenant_scope_label', locale) : uxText('chronos_scope', locale)}
        </span>
      </div>
      <select
        aria-label={uxText('chronos_tenant_scope_label', locale)}
        value={selected}
        onChange={(event) => updateScope('tenant', event.target.value)}
        className="min-w-44 rounded-lg border kb-border-subtle kb-surface-raised px-2 py-1.5 text-[11px] kb-text-primary outline-none"
      >
        <option value="">{uxText('chronos_all_tenants', locale)}</option>
        {tenants.map((tenant) => (
          <option key={tenant.slug} value={tenant.slug}>
            {tenant.displayName}
          </option>
        ))}
      </select>
      <span className="kb-text-muted" aria-hidden="true">
        ›
      </span>
      <select
        aria-label={uxText('chronos_organization_scope_label', locale)}
        value={selectedOrganization}
        onChange={(event) => updateScope('organization_id', event.target.value)}
        className="min-w-44 rounded-lg border kb-border-subtle kb-surface-raised px-2 py-1.5 text-[11px] kb-text-primary outline-none"
      >
        <option value="">{uxText('chronos_all_organizations', locale)}</option>
        {organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.id}
          </option>
        ))}
      </select>
      <span className="kb-text-muted" aria-hidden="true">
        ›
      </span>
      <select
        aria-label={uxText('chronos_project_scope_label', locale)}
        value={selectedProject}
        onChange={(event) => updateScope('project_id', event.target.value)}
        className="min-w-44 rounded-lg border kb-border-subtle kb-surface-raised px-2 py-1.5 text-[11px] kb-text-primary outline-none"
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
      {tenants.length > 0 ? (
        <div className="flex w-full flex-wrap items-center gap-1.5 pl-5 text-[10px]">
          <span className="kb-text-muted">{uxText('chronos_available_tenants', locale)}:</span>
          {tenants.map((tenant) => (
            <button
              key={tenant.slug}
              type="button"
              onClick={() => updateScope('tenant', tenant.slug)}
              className={`rounded-full border px-2 py-1 transition ${selected === tenant.slug ? 'kb-border-accent kb-surface-accent kb-text-accent' : 'kb-border-subtle kb-surface-raised kb-text-secondary hover:kb-border-accent'}`}
              aria-pressed={selected === tenant.slug}
            >
              {tenant.displayName}
            </button>
          ))}
        </div>
      ) : null}
      {loadError ? <span className="text-[10px] kb-status-negative">{loadError}</span> : null}
      <span className="flex items-center gap-1 text-[9px] kb-text-muted">
        <ShieldCheck size={11} /> server-authorized
      </span>
    </div>
  );
}
