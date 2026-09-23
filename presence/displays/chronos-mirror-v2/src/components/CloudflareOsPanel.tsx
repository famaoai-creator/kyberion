'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { Button, Callout, List, Section } from '@agent/shared-ui';
import { useChronosLocale } from '../lib/hooks';
import { uxText } from '../lib/ux-vocabulary';
import {
  parseCloudflareOsResponse,
  type CloudflareOsSnapshot,
} from '../lib/cloudflare-os-response';

/** Held-action status → canonical `ui:status-pill` status. */
const HELD_ACTION_STATUS: Record<CloudflareOsSnapshot['heldActions'][number]['status'], KbStatus> =
  {
    pending: 'pending',
    approved: 'ready',
    applied: 'done',
    rejected: 'stopped',
    cancelled: 'stopped',
    failed: 'failed',
  };

export function CloudflareOsPanel({ missionId }: { missionId?: string | null }) {
  const locale = useChronosLocale();
  const [snapshot, setSnapshot] = useState<CloudflareOsSnapshot>({
    heldActions: [],
    observations: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const loadSnapshot = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const query = missionId ? `?mission_id=${encodeURIComponent(missionId)}` : '';
      const response = await fetch(`/api/os/control-plane${query}`, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      const payload = parseCloudflareOsResponse(await response.json().catch(() => null));
      if (!response.ok || payload.ok !== true) {
        throw new Error(
          payload.ok !== true ? payload.error : `OS control plane ${response.status}`
        );
      }
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setSnapshot({
        heldActions: payload.snapshot.heldActions,
        observations: payload.snapshot.observations,
      });
      setError(null);
    } catch (reason) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setSnapshot({ heldActions: [], observations: [] });
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === requestSequence.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [missionId]);

  useEffect(() => {
    void loadSnapshot();
    return () => {
      requestSequence.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [loadSnapshot]);

  // UI-07: a compact read-only Section (held actions + observation audit as
  // two lists). Decisions and apply stay in the guarded surface.
  return (
    <Section
      title={uxText('chronos_os_control_plane', locale)}
      description={uxText('chronos_os_control_plane_description', locale)}
      headingLevel={2}
    >
      <div className="chronos-header__controls">
        <Button
          label={
            loading ? uxText('chronos_ac_refreshing', locale) : uxText('chronos_ac_refresh', locale)
          }
          variant="ghost"
          disabled={loading}
          onClick={() => void loadSnapshot()}
        />
      </div>
      {error ? <Callout tone="danger" title={error} /> : null}
      <div className="chronos-two-col">
        <div className="chronos-feed">
          <h3 className="chronos-feed__title">
            {uxText('chronos_os_held_actions', locale)} ({snapshot.heldActions.length})
          </h3>
          {snapshot.heldActions.length ? (
            <List
              items={snapshot.heldActions.slice(0, 8).map((item) => ({
                title: item.op,
                meta: [
                  item.missionId,
                  item.tenantSlug || 'public',
                  item.submittedBy,
                  item.irreversible
                    ? uxText('chronos_os_irreversible', locale)
                    : uxText('chronos_os_reversible', locale),
                  item.effectBinding || uxText('chronos_os_effect_binding_unavailable', locale),
                  item.failureRecorded ? uxText('chronos_os_apply_failed', locale) : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
                status: HELD_ACTION_STATUS[item.status],
              }))}
            />
          ) : (
            <p className="kb-text kb-text--muted">{uxText('chronos_os_no_held_actions', locale)}</p>
          )}
        </div>
        <div className="chronos-feed">
          <h3 className="chronos-feed__title">
            {uxText('chronos_os_observations', locale)} ({snapshot.observations.length})
          </h3>
          {snapshot.observations.length ? (
            <List
              items={snapshot.observations.slice(0, 8).map((item) => ({
                title: item.service,
                meta: [item.tier, item.resourceRef, item.purpose, item.summary]
                  .filter(Boolean)
                  .join(' · '),
              }))}
            />
          ) : (
            <p className="kb-text kb-text--muted">{uxText('chronos_os_no_observations', locale)}</p>
          )}
        </div>
      </div>
    </Section>
  );
}
