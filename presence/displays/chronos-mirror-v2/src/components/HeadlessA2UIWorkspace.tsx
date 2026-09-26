'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Callout, Section, Skeleton, Stack } from '@agent/shared-ui';
import { ChronosA2UIRenderer } from './A2UIComponentLibrary';
import { ChronosKbI18n } from './chronos-kb-i18n';
import { useChronosLocale } from '../lib/hooks';
import { uxMessage, uxText, uxTextOr } from '../lib/ux-vocabulary';
import {
  parseHeadlessA2UIResponse,
  type HeadlessA2UIComponent,
} from '../lib/headless-a2ui-response';
import { PluginViewFrame } from './PluginViewFrame';
import { parsePluginViewFrames, type PluginViewFrameItem } from '../lib/plugin-view-frame-broker';
import {
  parsePluginHostSummary,
  parsePluginViewActionRequests,
  pluginHostBadges,
  pluginViewActionExecuteBody,
  pluginViewActionRequestControl,
  pluginViewActionRequestTone,
  pluginViewActionStatusKey,
  pluginViewActionUnavailableKey,
  type PluginHostSummary,
  type PluginViewActionRequestItem,
} from '../lib/plugin-view-action-requests';

/**
 * The scoped operator-home projection fetched from the headless API and
 * rendered through the same A2UI path as every other chronos surface
 * (`ChronosA2UIRenderer` → shared `@agent/shared-ui` renderer).
 * `source="plugin-views"` renders the EP-05 plugin views the viewer may see,
 * plus the human view actions queued for approval (FU-02): an approved one
 * can be executed once from here. PH-01/02: a badge shows the Chronos plugin
 * host state and `sandboxed-iframe` views render in `PluginViewFrame`.
 */
export function HeadlessA2UIWorkspace({
  tenant,
  organizationId,
  projectId,
  source = 'operator-home',
}: {
  tenant?: string;
  organizationId?: string;
  projectId?: string;
  source?: 'operator-home' | 'plugin-views';
}) {
  const pluginViews = source === 'plugin-views';
  const locale = useChronosLocale();
  const [components, setComponents] = useState<HeadlessA2UIComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionRequests, setActionRequests] = useState<PluginViewActionRequestItem[]>([]);
  const [frames, setFrames] = useState<PluginViewFrameItem[]>([]);
  const [host, setHost] = useState<PluginHostSummary>({ enabled: false });
  const [actionError, setActionError] = useState<string | null>(null);
  const [executing, setExecuting] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (tenant) params.set('tenant', tenant);
    if (!pluginViews && organizationId) params.set('organization_id', organizationId);
    if (!pluginViews && projectId) params.set('project_id', projectId);
    const encoded = params.toString();
    return encoded ? `?${encoded}` : '';
  }, [tenant, organizationId, projectId, pluginViews]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/headless/a2ui/${source}${query}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`headless A2UI ${response.status}`);
        const raw: unknown = await response.json().catch(() => null);
        const payload = parseHeadlessA2UIResponse(raw);
        if (!payload) throw new Error('Invalid headless A2UI response');
        return {
          payload,
          requests: pluginViews ? parsePluginViewActionRequests(raw) : [],
          frames: pluginViews ? parsePluginViewFrames(raw) : [],
          host: pluginViews ? parsePluginHostSummary(raw) : { enabled: false },
        };
      })
      .then(({ payload, requests, frames: frameViews, host: hostSummary }) => {
        if (cancelled) return;
        setComponents(payload.data.a2ui.updateComponents.components);
        setActionRequests(requests);
        setFrames(frameViews);
        setHost(hostSummary);
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
  }, [query, source, pluginViews, reloadToken]);

  const reloadAfterFrameAction = useCallback(() => setReloadToken((token) => token + 1), []);

  const executeAction = async (item: PluginViewActionRequestItem) => {
    setExecuting(item.approvalRequestId);
    setActionError(null);
    try {
      const response = await fetch('/api/headless/a2ui/plugin-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pluginViewActionExecuteBody(item)),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const errorKey =
          body && typeof body === 'object' && 'error_key' in body ? String(body.error_key) : '';
        const failed = uxText('view_action_execute_failed', locale);
        setActionError(errorKey ? uxTextOr(errorKey, failed, locale) : failed);
      }
    } catch {
      setActionError(uxText('view_action_execute_failed', locale));
    } finally {
      setExecuting(null);
      setReloadToken((token) => token + 1);
    }
  };

  return (
    <ChronosKbI18n>
      <Section
        title={
          pluginViews
            ? uxText('view_menu_label', locale)
            : uxTextOr('chronos_headless_a2ui_title', 'Headless API → A2UI', locale)
        }
        description={
          pluginViews
            ? uxText('view_menu_description', locale)
            : uxTextOr(
                'chronos_headless_a2ui_description',
                'The same scoped operator projection rendered through the A2UI adapter.',
                locale
              )
        }
      >
        {error ? (
          <Callout
            tone="danger"
            title={
              pluginViews
                ? uxText('view_load_error', locale)
                : uxTextOr(
                    'chronos_headless_a2ui_error',
                    'The headless projection could not be loaded.',
                    locale
                  )
            }
            body={error}
          />
        ) : components === null ? (
          <Skeleton shape="card" lines={4} />
        ) : pluginViews && components.length === 0 && frames.length === 0 ? (
          <Callout tone="info" title={uxText('view_empty', locale)} />
        ) : components.length > 0 || !pluginViews ? (
          <ChronosA2UIRenderer components={components} />
        ) : null}
        {pluginViews && components !== null && !error ? (
          <Stack direction="horizontal" gap="sm" align="center">
            {pluginHostBadges(host).map((badge) => (
              <Badge
                key={badge.key}
                tone={badge.tone}
                label={uxMessage(badge.key, { n: badge.count ?? 0 }, badge.key, locale)}
              />
            ))}
          </Stack>
        ) : null}
        {pluginViews && !error
          ? frames.map((frame) => (
              <PluginViewFrame
                key={`${frame.pluginId}/${frame.viewId}`}
                view={frame}
                locale={locale}
                onActionSubmitted={reloadAfterFrameAction}
              />
            ))
          : null}
        {pluginViews && actionRequests.length > 0 ? (
          <Section
            title={uxText('view_action_requests_title', locale)}
            description={uxText('view_action_requests_description', locale)}
          >
            {actionError ? <Callout tone="danger" title={actionError} /> : null}
            <Stack gap="sm">
              {actionRequests.map((item) => (
                <Stack key={item.approvalRequestId} direction="horizontal" gap="sm" align="center">
                  <Badge
                    label={uxTextOr(pluginViewActionStatusKey(item.status), item.status, locale)}
                    tone={pluginViewActionRequestTone(item.status)}
                  />
                  <span>{`${item.pluginId} / ${item.viewId} / ${item.actionId}`}</span>
                  {pluginViewActionRequestControl(item) === 'execute' ? (
                    <Button
                      label={uxText('view_action_execute', locale)}
                      variant="primary"
                      disabled={executing !== null}
                      onClick={() => {
                        void executeAction(item);
                      }}
                    />
                  ) : pluginViewActionRequestControl(item) === 'not_executable' ? (
                    <span>
                      {uxTextOr(
                        pluginViewActionUnavailableKey(item, host),
                        uxText('view_action_not_executable', locale),
                        locale
                      )}
                    </span>
                  ) : null}
                </Stack>
              ))}
            </Stack>
          </Section>
        ) : null}
      </Section>
    </ChronosKbI18n>
  );
}
