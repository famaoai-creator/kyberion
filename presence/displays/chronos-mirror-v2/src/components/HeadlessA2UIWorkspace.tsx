'use client';

import { useEffect, useMemo, useState } from 'react';
import { A2UIRenderer } from './A2UIComponentLibrary';
import {
  parseHeadlessA2UIResponse,
  type HeadlessA2UIComponent,
} from '../lib/headless-a2ui-response';

export function HeadlessA2UIWorkspace({
  tenant,
  organizationId,
  projectId,
}: {
  tenant?: string;
  organizationId?: string;
  projectId?: string;
}) {
  const [components, setComponents] = useState<HeadlessA2UIComponent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (tenant) params.set('tenant', tenant);
    if (organizationId) params.set('organization_id', organizationId);
    if (projectId) params.set('project_id', projectId);
    const encoded = params.toString();
    return encoded ? `?${encoded}` : '';
  }, [tenant, organizationId, projectId]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/headless/a2ui/operator-home${query}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`headless A2UI ${response.status}`);
        const payload = parseHeadlessA2UIResponse(await response.json().catch(() => null));
        if (!payload) throw new Error('Invalid headless A2UI response');
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setComponents(payload.data.a2ui.updateComponents.components);
        setError(null);
      })
      .catch((reason) => {
        if (cancelled) return;
        setComponents([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <section className="rounded-[24px] border kb-border-subtle kb-surface-well p-4">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.24em] kb-text-accent">
            Headless API → A2UI
          </div>
          <div className="mt-1 text-[11px] kb-text-secondary">
            The same scoped operator projection rendered through the A2UI adapter.
          </div>
        </div>
        <code className="text-[9px] kb-text-muted">operator-home</code>
      </div>
      {error ? (
        <div className="rounded-xl border kb-status-negative-border kb-status-negative-surface p-3 text-[10px] kb-status-negative">
          {error}
        </div>
      ) : components.length === 0 ? (
        <div className="rounded-xl border kb-border-subtle p-3 text-[10px] kb-text-secondary">
          Loading headless projection…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {components.map((component) => (
            <A2UIRenderer key={component.id} type={component.type} props={component.props} />
          ))}
        </div>
      )}
    </section>
  );
}
