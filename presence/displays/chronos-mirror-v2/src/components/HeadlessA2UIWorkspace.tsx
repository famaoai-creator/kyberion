'use client';

import { useEffect, useMemo, useState } from 'react';
import { Callout, Section, Skeleton } from '@agent/shared-ui';
import { ChronosA2UIRenderer } from './A2UIComponentLibrary';
import { ChronosKbI18n } from './chronos-kb-i18n';
import { useChronosLocale } from '../lib/hooks';
import { uxTextOr } from '../lib/ux-vocabulary';
import {
  parseHeadlessA2UIResponse,
  type HeadlessA2UIComponent,
} from '../lib/headless-a2ui-response';

/**
 * The scoped operator-home projection fetched from the headless API and
 * rendered through the same A2UI path as every other chronos surface
 * (`ChronosA2UIRenderer` → shared `@agent/shared-ui` renderer).
 */
export function HeadlessA2UIWorkspace({
  tenant,
  organizationId,
  projectId,
}: {
  tenant?: string;
  organizationId?: string;
  projectId?: string;
}) {
  const locale = useChronosLocale();
  const [components, setComponents] = useState<HeadlessA2UIComponent[] | null>(null);
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
    <ChronosKbI18n>
      <Section
        title={uxTextOr('chronos_headless_a2ui_title', 'Headless API → A2UI', locale)}
        description={uxTextOr(
          'chronos_headless_a2ui_description',
          'The same scoped operator projection rendered through the A2UI adapter.',
          locale
        )}
      >
        {error ? (
          <Callout
            tone="danger"
            title={uxTextOr(
              'chronos_headless_a2ui_error',
              'The headless projection could not be loaded.',
              locale
            )}
            body={error}
          />
        ) : components === null ? (
          <Skeleton shape="card" lines={4} />
        ) : (
          <ChronosA2UIRenderer components={components} />
        )}
      </Section>
    </ChronosKbI18n>
  );
}
