'use client';

import * as React from 'react';
import { changeWorkspaceSelection } from '@agent/core/surface/workspace-query';
import { Building2, ShieldCheck } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useChronosLocale } from '../lib/hooks';
import { clearCustomerDecisionSelection } from '../lib/customer-decision-navigation';
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
  const [operations, setOperations] = React.useState<ChronosProjectOption[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retry, setRetry] = React.useState(0);
  const selected = searchParams.get('tenant') || '';
  const selectedOrganization = searchParams.get('organization_id') || '';
  const selectedProject = searchParams.get('project_id') || '';
  const selectedOperation = searchParams.get('operation_id') || '';
  const selectedTier = searchParams.get('tier') || '';
  const scopeKey = JSON.stringify([
    locale,
    selected,
    selectedOrganization,
    selectedProject,
    selectedOperation,
    selectedTier,
  ]);
  const [loadedScope, setLoadedScope] = React.useState<string | null>(null);
  const unavailable = loadedScope !== scopeKey || !!loadError;
  const organizationValue = (organization: ChronosOrganizationOption) =>
    JSON.stringify([
      organization.id,
      organization.tenant_slug || '',
      organization.tier || 'confidential',
    ]);
  const currentOrganization = organizations.find(
    (organization) =>
      organization.id === selectedOrganization &&
      (organization.tenant_slug || '') === selected &&
      (!selectedTier || (organization.tier || 'confidential') === selectedTier)
  );

  React.useEffect(() => {
    let cancelled = false;
    setLoadedScope(null);
    setLoadError(null);
    setTenants([]);
    setOrganizations([]);
    setProjects([]);
    setOperations([]);
    const params = new URLSearchParams();
    if (selected) params.set('tenant', selected);
    if (selectedOrganization) params.set('organization_id', selectedOrganization);
    if (selectedProject) params.set('project_id', selectedProject);
    if (selectedOperation) params.set('operation_id', selectedOperation);
    if (selectedTier) params.set('tier', selectedTier);
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
          setOperations(normalized.operations);
          setLoadError(null);
          setLoadedScope(scopeKey);
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
  }, [
    locale,
    selected,
    selectedOrganization,
    selectedProject,
    selectedOperation,
    selectedTier,
    scopeKey,
    retry,
  ]);

  const updateScope = (
    key: 'tenant' | 'organization_id' | 'project_id' | 'operation_id',
    value: string,
    organizationOption?: ChronosOrganizationOption
  ) => {
    let params = changeWorkspaceSelection(new URLSearchParams(searchParams.toString()), key, value);
    // CD-12: a customer-decision drill-down (cd_*) belongs to one tenant.
    if (key === 'tenant' || key === 'organization_id')
      params = clearCustomerDecisionSelection(params);
    if (
      key === 'organization_id' &&
      organizationOption &&
      (organizationOption.tier || 'confidential') !== (selectedTier || 'confidential')
    ) {
      params = changeWorkspaceSelection(params, 'organization_id', '');
      params = changeWorkspaceSelection(params, 'organization_id', value);
    }
    if (key === 'project_id' && value) {
      const project = projects.find((item) => item.id === value);
      if (project) {
        for (const [name, parent] of [
          ['tenant', project.tenant_slug],
          ['organization_id', project.organization_id],
          ['tier', project.tier],
        ] as const) {
          if (parent) params.set(name, parent);
          else params.delete(name);
        }
      }
    }
    if (key === 'organization_id' && value) {
      const organization =
        organizationOption ||
        organizations.find((item) => item.id === value && (item.tenant_slug || '') === selected);
      if (organization) {
        if (organization.tier) params.set('tier', organization.tier);
        else params.delete('tier');
      }
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
      <span className="kb-select-wrap chronos-scope__field">
        <select
          aria-label={uxText('chronos_tenant_scope_label', locale)}
          value={selected}
          disabled={unavailable}
          onChange={(event) => updateScope('tenant', event.target.value)}
          className="kb-input kb-select chronos-scope__select"
        >
          <option value="">{uxText('chronos_all_tenants', locale)}</option>
          {tenants.map((tenant) => (
            <option key={tenant.slug} value={tenant.slug}>
              {tenant.displayName}
            </option>
          ))}
        </select>
      </span>
      <span className="chronos-scope__sep" aria-hidden="true">
        ›
      </span>
      <span className="kb-select-wrap chronos-scope__field">
        <select
          aria-label={uxText('chronos_organization_scope_label', locale)}
          value={currentOrganization ? organizationValue(currentOrganization) : ''}
          disabled={unavailable}
          onChange={(event) => {
            const organization = organizations.find(
              (item) => organizationValue(item) === event.target.value
            );
            updateScope('organization_id', organization?.id || '', organization);
          }}
          className="kb-input kb-select chronos-scope__select"
        >
          <option value="">{uxText('chronos_all_organizations', locale)}</option>
          {organizations
            .filter((organization) => (organization.tenant_slug || '') === selected)
            .map((organization) => (
              <option key={organizationValue(organization)} value={organizationValue(organization)}>
                {organization.id}
                {organization.tier && organization.tier !== 'confidential'
                  ? ` · ${organization.tier}`
                  : ''}
              </option>
            ))}
        </select>
      </span>
      <span className="chronos-scope__sep" aria-hidden="true">
        ›
      </span>
      <span className="kb-select-wrap chronos-scope__field">
        <select
          aria-label={uxText('chronos_project_scope_label', locale)}
          value={selectedProject}
          disabled={unavailable}
          onChange={(event) => updateScope('project_id', event.target.value)}
          className="kb-input kb-select chronos-scope__select"
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
      </span>
      <span className="kb-select-wrap chronos-scope__field">
        <select
          aria-label={uxText('chronos_workspace_operation', locale)}
          value={selectedOperation}
          disabled={unavailable || !selectedOrganization}
          onChange={(event) => updateScope('operation_id', event.target.value)}
          className="kb-input kb-select chronos-scope__select"
        >
          <option value="">{uxText('chronos_workspace_select_operation', locale)}</option>
          {operations
            .filter(
              (operation) =>
                (operation.tenant_slug || '') === selected &&
                (!selectedTier || (operation.tier || 'confidential') === selectedTier) &&
                (!selectedOrganization || operation.organization_id === selectedOrganization)
            )
            .map((operation) => (
              <option key={operation.id} value={operation.id}>
                {operation.name || operation.id}
              </option>
            ))}
        </select>
      </span>
      <span className="chronos-scope__note">
        <ShieldCheck size={11} aria-hidden="true" />
        {uxText('chronos_scope_server_authorized', locale)}
      </span>
      {loadError ? (
        <>
          <span role="alert" className="chronos-scope__error">
            {loadError}
          </span>
          <button
            type="button"
            className="kb-button"
            onClick={() => {
              router.push(pathname);
              setRetry((value) => value + 1);
            }}
          >
            {uxText('chronos_workspace_clear_selection_retry', locale)}
          </button>
        </>
      ) : null}
    </div>
  );
}
