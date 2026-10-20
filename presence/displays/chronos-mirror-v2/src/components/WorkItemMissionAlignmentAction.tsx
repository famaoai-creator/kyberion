'use client';
import * as React from 'react';
import { Button } from '@agent/shared-ui';
import { uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import type { ClientWorkItem, ClientMissionAdmission } from '../lib/workitems-response';

/** Requesting approval is visibly distinct from completing or starting the work. */
export function WorkItemMissionAlignmentAction({
  item,
  admission,
  busy,
  locale,
  onRequest,
}: {
  item: ClientWorkItem;
  admission?: ClientMissionAdmission;
  busy: boolean;
  locale: SupportedLocale;
  onRequest: (itemId: string) => unknown;
}) {
  const eligible = Boolean(
    item.context?.tenant_slug &&
    item.metadata?.admission_only === true &&
    item.metadata?.requested_work_shape === 'mission' &&
    ['blocked', 'ready'].includes(item.status)
  );
  if (!eligible && !admission) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {eligible && !admission ? (
        <Button
          label={uxText('chronos_work_item_request_alignment', locale)}
          variant="secondary"
          disabled={busy}
          onClick={() => void onRequest(item.item_id)}
        />
      ) : null}
      {admission ? (
        <div className="kb-list__meta">
          <span>
            {uxText(
              admission.status === 'pending'
                ? 'chronos_work_item_alignment_pending'
                : admission.status === 'approved'
                  ? 'chronos_work_item_alignment_approved'
                  : 'chronos_work_item_alignment_held',
              locale
            )}
          </span>
          {' · '}
          {admission.requestId}
          {' · '}
          <a
            href={
              '/?section=approvals&request=' +
              encodeURIComponent(admission.requestId) +
              '&mission=' +
              encodeURIComponent(admission.missionId)
            }
          >
            {uxText('chronos_action_route_to_approvals', locale)}
          </a>
        </div>
      ) : null}
    </div>
  );
}
