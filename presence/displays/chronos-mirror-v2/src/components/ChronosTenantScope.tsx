'use client';

import * as React from 'react';
import { Building2, ShieldCheck } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';

export function useChronosTenant(): string {
  return useSearchParams().get('tenant') || '';
}

export function ChronosTenantScope({ compact = false }: { compact?: boolean }) {
  const locale = useChronosLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tenants, setTenants] = React.useState<
    Array<{ slug: string; displayName: string; status?: string }>
  >([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const selected = searchParams.get('tenant') || '';

  React.useEffect(() => {
    let cancelled = false;
    void fetch('/api/tenant-scope', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled && Array.isArray(payload.tenants)) {
          setTenants(
            payload.tenants
              .map((tenant: unknown) =>
                typeof tenant === 'string'
                  ? { slug: tenant, displayName: tenant }
                  : tenant && typeof tenant === 'object' && typeof (tenant as any).slug === 'string'
                    ? {
                        slug: (tenant as any).slug,
                        displayName:
                          typeof (tenant as any).displayName === 'string'
                            ? (tenant as any).displayName
                            : (tenant as any).slug,
                        status: (tenant as any).status,
                      }
                    : null
              )
              .filter(Boolean)
          );
          setLoadError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(uxText('chronos_tenant_scope_unavailable', locale));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateTenant = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set('tenant', value);
    else params.delete('tenant');
    router.replace(`${pathname}${params.size ? `?${params.toString()}` : ''}`, { scroll: false });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border kb-border-accent kb-surface-accent px-3 py-2">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] kb-text-accent">
        <Building2 size={13} />
        <span>{compact ? 'tenant' : uxText('chronos_scope', locale)}</span>
      </div>
      <select
        aria-label="tenant scope"
        value={selected}
        onChange={(event) => updateTenant(event.target.value)}
        className="min-w-44 rounded-lg border kb-border-subtle kb-surface-raised px-2 py-1.5 text-[11px] kb-text-primary outline-none"
      >
        <option value="">{uxText('chronos_all_tenants', locale)}</option>
        {tenants.map((tenant) => (
          <option key={tenant.slug} value={tenant.slug}>
            {tenant.displayName}
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
              onClick={() => updateTenant(tenant.slug)}
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
