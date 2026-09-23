'use client';

import * as React from 'react';
import {
  Badge,
  Button,
  Callout,
  Disclosure,
  EmptyState,
  KeyValue,
  List,
  Section,
  StatusPill,
} from '@agent/shared-ui';
import { WsPreformatted, WsSelectTable, WsTextareaField, WsTitleCell } from './ChronosWsParts';
import { useChronosLocale } from '../lib/hooks';
import {
  formatChronosDateTime,
  uxText,
  uxTextOr,
  type SupportedLocale,
} from '../lib/ux-vocabulary';
import { parseApprovalsResponse, type ClientApproval } from '../lib/approvals-response';

type Approval = ClientApproval;

function approvalRiskLabel(value: string | undefined, locale: SupportedLocale): string {
  const labels: Record<string, string> = {
    low: 'chronos_risk_low',
    medium: 'chronos_risk_medium',
    high: 'chronos_risk_high',
    critical: 'chronos_risk_critical',
  };
  return uxText(labels[value || ''] || 'chronos_unknown', locale);
}

function approvalMutationLabel(value: string | undefined, locale: SupportedLocale): string {
  const labels: Record<string, string> = {
    create: 'chronos_change_create',
    update: 'chronos_change_update',
    delete: 'chronos_change_delete',
    rotate: 'chronos_change_rotate',
  };
  return uxText(labels[value || ''] || 'chronos_change_other', locale);
}

export function ApprovalsWorkspace({ tenant }: { tenant?: string }) {
  const locale = useChronosLocale();
  const [items, setItems] = React.useState<Approval[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [accessRole, setAccessRole] = React.useState<'readonly' | 'localadmin'>('readonly');
  const [note, setNote] = React.useState('');
  const selected = items.find((item) => item.id === selectedId) || items[0] || null;

  const refresh = React.useCallback(async () => {
    try {
      const query = new URLSearchParams({ status: 'pending', limit: '50' });
      if (tenant) query.set('tenant', tenant);
      const response = await fetch(`/api/approvals?${query.toString()}`, { cache: 'no-store' });
      const payload = parseApprovalsResponse(await response.json().catch(() => null));
      if (!response.ok || !payload) throw new Error('Invalid approval queue response');
      setAccessRole(payload.accessRole);
      setItems(payload.approvals);
      setSelectedId((current) =>
        payload.approvals.some((item) => item.id === current)
          ? current
          : payload.approvals[0]?.id || null
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approval_decision',
          requestId: selected.id,
          channel: selected.channel,
          storageChannel: selected.storageChannel,
          decision,
          note,
          tenant,
        }),
      });
      if (!response.ok) throw new Error('Failed to record the approval decision');
      setNote('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const localAdmin = accessRole === 'localadmin';
  const scopeLabel = `${tenant || uxText('chronos_ac_scope_all', locale)} · ${items.length}`;
  const kindFallback = uxTextOr('chronos_ws_approval_kind_default', 'Approval', locale);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.5fr)]">
      <Section
        title={uxText('chronos_approvals_title', locale)}
        description={uxText('chronos_approvals_description', locale)}
      >
        <div className="flex flex-wrap gap-2">
          <Badge label={scopeLabel} tone="accent" />
        </div>
        {error ? (
          <Callout
            tone="danger"
            title={uxTextOr('chronos_ws_load_failed', 'Could not load this view', locale)}
            body={error}
          />
        ) : null}
        <WsSelectTable
          columns={[
            { key: 'title', label: uxTextOr('chronos_ws_col_request', 'Request', locale) },
            {
              key: 'risk',
              label: uxText('chronos_risk', locale),
              width: '6rem',
            },
          ]}
          rows={items}
          rowKey={(item) => item.id}
          selectedKey={selected?.id}
          onSelect={setSelectedId}
          empty={uxText('chronos_approvals_empty', locale)}
          renderCell={(item, key, select) =>
            key === 'title' ? (
              <div className="flex flex-col gap-0.5">
                <WsTitleCell
                  title={item.title}
                  id={`${item.tenantSlug || uxText('chronos_org_not_configured', locale)} / ${item.kind || kindFallback}`}
                  onSelect={select}
                  selected={selected?.id === item.id}
                />
                <span className="kb-list__meta">
                  {item.requestedBy} · {formatChronosDateTime(item.requestedAt, locale)}
                </span>
              </div>
            ) : (
              <Badge
                label={approvalRiskLabel(item.risk?.level, locale)}
                tone={riskTone(item.risk?.level)}
              />
            )
          }
        />
      </Section>

      {selected ? (
        <Section
          title={selected.title}
          description={uxTextOr('chronos_ws_approval_detail_eyebrow', 'Approval content', locale)}
        >
          <div className="flex flex-wrap gap-2">
            <Badge
              label={`${uxText('chronos_risk', locale)}: ${approvalRiskLabel(selected.risk?.level, locale)}`}
              tone={riskTone(selected.risk?.level)}
            />
            {selected.risk?.level === 'critical' ? (
              <StatusPill
                status="blocked"
                label={uxText('chronos_additional_confirmation_hint', locale)}
              />
            ) : null}
          </div>
          {selected.summary ? (
            <p className="kb-text kb-text--body" style={{ whiteSpace: 'pre-wrap' }}>
              {selected.summary}
            </p>
          ) : null}
          {selected.details ? (
            <Disclosure summary={uxTextOr('chronos_ws_details', 'Details', locale)} open>
              <p className="kb-text kb-text--muted" style={{ whiteSpace: 'pre-wrap' }}>
                {selected.details}
              </p>
            </Disclosure>
          ) : null}
          <div className="chronos-two-col">
            <div className="chronos-feed">
              <h3 className="chronos-feed__title">
                {uxText('chronos_approval_change_details', locale)}
              </h3>
              <KeyValue
                items={[
                  {
                    label: uxText('chronos_approval_service', locale),
                    value: selected.target?.serviceId || '-',
                    mono: true,
                  },
                  {
                    label: uxText('chronos_approval_operation', locale),
                    value: approvalMutationLabel(selected.target?.mutation, locale),
                  },
                  {
                    label: uxText('chronos_approval_key', locale),
                    value: selected.target?.secretKey || '-',
                    mono: true,
                  },
                  {
                    label: uxText('chronos_approval_current_value', locale),
                    value: selected.target?.existingValuePresent
                      ? uxText('chronos_approval_value_present', locale)
                      : uxText('chronos_approval_value_missing', locale),
                  },
                ]}
              />
            </div>
            <div className="chronos-feed">
              <h3 className="chronos-feed__title">
                {uxTextOr('chronos_ws_approval_cautions', 'Points to check', locale)}
              </h3>
              <KeyValue
                items={[
                  {
                    label: uxText('chronos_approval_restart', locale),
                    value:
                      selected.risk?.restartScope || uxText('chronos_approval_not_needed', locale),
                  },
                  {
                    label: uxText('chronos_approval_strong_auth', locale),
                    value: selected.risk?.requiresStrongAuth
                      ? uxText('chronos_required', locale)
                      : uxText('chronos_not_required', locale),
                  },
                  {
                    label: uxText('chronos_approval_policy', locale),
                    value:
                      selected.risk?.policyId || uxText('chronos_approval_default_policy', locale),
                    mono: Boolean(selected.risk?.policyId),
                  },
                ]}
              />
            </div>
          </div>
          {selected.justification ? (
            <div className="chronos-feed">
              <h3 className="chronos-feed__title">{uxText('chronos_reason_impact', locale)}</h3>
              <p className="kb-text kb-text--body">{selected.justification.reason}</p>
              {selected.justification.impactSummary ? (
                <p className="kb-text kb-text--muted">
                  {uxTextOr('chronos_ws_impact', 'Impact', locale)}:{' '}
                  {selected.justification.impactSummary}
                </p>
              ) : null}
              {selected.justification.requestedEffects?.length ? (
                <List
                  items={selected.justification.requestedEffects.map((effect) => ({
                    title: effect,
                  }))}
                />
              ) : null}
            </div>
          ) : null}
          <KeyValue
            items={[
              {
                label: uxText('chronos_tenant', locale),
                value: selected.tenantSlug || '-',
                mono: true,
              },
              {
                label: uxText('chronos_project', locale),
                value: selected.workLoop?.project_id || '-',
                mono: true,
              },
              {
                label: uxText('chronos_mission', locale),
                value: selected.missionId || '-',
                mono: true,
              },
            ]}
          />
          {selected.sourceText ? (
            <Disclosure summary={uxText('chronos_request_source', locale)}>
              <WsPreformatted text={selected.sourceText} />
            </Disclosure>
          ) : null}
          <WsTextareaField
            id="chronos-approval-note"
            label={uxTextOr('chronos_ws_decision_note_label', 'Decision note', locale)}
            value={note}
            onChange={setNote}
            placeholder={uxText('chronos_decision_note', locale)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              label={uxText('chronos_approve', locale)}
              variant="primary"
              disabled={busy || !localAdmin}
              onClick={() => void decide('approved')}
            />
            <Button
              label={uxText('chronos_reject', locale)}
              variant="danger"
              disabled={busy || !localAdmin}
              onClick={() => void decide('rejected')}
            />
          </div>
          {!localAdmin ? (
            <p className="kb-text kb-text--muted">{uxText('chronos_admin_action_hint', locale)}</p>
          ) : null}
        </Section>
      ) : (
        <Section>
          <EmptyState title={uxText('chronos_select_approval', locale)} />
        </Section>
      )}
    </div>
  );
}

function riskTone(level: string | undefined): 'neutral' | 'warning' | 'danger' {
  if (level === 'high' || level === 'critical') return 'danger';
  if (level === 'medium') return 'warning';
  return 'neutral';
}
