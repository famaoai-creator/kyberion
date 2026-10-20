'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
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
import {
  approvalProjectId,
  parseApprovalsResponse,
  type ClientApproval,
} from '../lib/approvals-response';
import { approvalWorkspaceQuery, knowledgeCandidateHref } from '../lib/knowledge-learning-client';

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
function approvalTenantLabel(item: Approval, locale: SupportedLocale): string | undefined {
  if (!item.tenantSlug) return undefined;
  return item.tenantSource === 'mission'
    ? item.tenantSlug + ' (' + uxText('chronos_tenant_from_mission', locale) + ')'
    : item.tenantSlug;
}
function approvalStatusLabel(status: string, locale: SupportedLocale): string {
  const labels: Record<string, string> = {
    pending: 'chronos_learning_pending',
    approved: 'chronos_learning_approved',
    rejected: 'chronos_learning_rejected',
    expired: 'chronos_learning_expired',
    revoked: 'chronos_learning_revoked',
    cancelled: 'chronos_learning_cancelled',
  };
  return uxText(labels[status] || 'chronos_unknown', locale);
}
const selectionKey = (item: Approval) => JSON.stringify([item.storageChannel, item.id]);

export function ApprovalsWorkspace({ tenant }: { tenant?: string }) {
  const locale = useChronosLocale();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const requestedId = searchParams.get('request');
  const requestedChannel = searchParams.get('storageChannel');
  const returnCandidateKey = searchParams.get('candidateKey');
  const [items, setItems] = React.useState<Approval[]>([]);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [fresh, setFresh] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [accessRole, setAccessRole] = React.useState<'readonly' | 'localadmin'>('readonly');
  const [note, setNote] = React.useState('');
  const refreshVersion = React.useRef(0);
  const mutationInFlight = React.useRef(false);
  const view = React.useRef({ tenant, search });
  view.current = { tenant, search };
  const selected = selectedKey
    ? items.find((item) => selectionKey(item) === selectedKey) || null
    : null;

  const refresh = React.useCallback(async () => {
    const version = ++refreshVersion.current;
    setFresh(false);
    try {
      const query = approvalWorkspaceQuery(search, tenant);
      const response = await fetch('/api/approvals?' + query.toString(), { cache: 'no-store' });
      const payload = parseApprovalsResponse(await response.json().catch(() => null));
      if (!response.ok || !payload)
        throw new Error(uxText('chronos_learning_review_load_failed', locale));
      if (
        version !== refreshVersion.current ||
        tenant !== view.current.tenant ||
        search !== view.current.search
      )
        return;
      setAccessRole(payload.accessRole);
      setItems(payload.approvals);
      if (requestedId) {
        const exact = payload.approvals.filter(
          (item) =>
            item.id === requestedId &&
            (!requestedChannel || item.storageChannel === requestedChannel)
        );
        setSelectedKey(exact.length === 1 ? selectionKey(exact[0]) : null);
      } else {
        setSelectedKey((current) =>
          payload.approvals.some((item) => selectionKey(item) === current)
            ? current
            : payload.approvals[0]
              ? selectionKey(payload.approvals[0])
              : null
        );
      }
      setFresh(true);
      setError(null);
    } catch (err) {
      if (
        version !== refreshVersion.current ||
        tenant !== view.current.tenant ||
        search !== view.current.search
      )
        return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tenant, search, requestedId, requestedChannel, locale]);
  React.useEffect(() => {
    setItems([]);
    setSelectedKey(null);
    void refresh();
    return () => {
      refreshVersion.current += 1;
    };
  }, [refresh]);
  React.useEffect(() => {
    setNote('');
  }, [selectedKey]);

  const decide = async (decision: 'approved' | 'rejected') => {
    if (
      !selected ||
      !fresh ||
      accessRole !== 'localadmin' ||
      selected.status !== 'pending' ||
      mutationInFlight.current
    )
      return;
    mutationInFlight.current = true;
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
          ...(selected.presentedDigest ? { presentedDigest: selected.presentedDigest } : {}),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (
        !response.ok ||
        payload?.ok !== true ||
        payload.approval?.id !== selected.id ||
        payload.approval?.storageChannel !== selected.storageChannel ||
        typeof payload.approval?.status !== 'string'
      )
        throw new Error(uxText('chronos_learning_outcome_unknown', locale));
      if (tenant !== view.current.tenant || search !== view.current.search) return;
      setNote('');
      await refresh();
    } catch (err) {
      if (tenant !== view.current.tenant || search !== view.current.search) return;
      setFresh(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      mutationInFlight.current = false;
      setBusy(false);
    }
  };

  const localAdmin = accessRole === 'localadmin';
  const scopeLabel = (tenant || uxText('chronos_ac_scope_all', locale)) + ' · ' + items.length;
  const kindFallback = uxTextOr('chronos_ws_approval_kind_default', 'Approval', locale);
  const learningReview =
    selected?.justification?.requestedEffects?.some((effect) =>
      effect.startsWith('scoped-learning:')
    ) === true;
  const returnHref = returnCandidateKey ? knowledgeCandidateHref(returnCandidateKey, tenant) : null;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.5fr)]">
      <Section
        title={uxText('chronos_approvals_title', locale)}
        description={uxText('chronos_approvals_description', locale)}
      >
        <div className="flex flex-wrap gap-2">
          <Badge label={scopeLabel} tone="accent" />
          <Button
            label={uxText('chronos_learning_refresh', locale)}
            variant="secondary"
            disabled={busy}
            onClick={() => void refresh()}
          />
          {returnHref ? (
            <a className="kb-link" href={returnHref}>
              {uxText('chronos_learning_return', locale)}
            </a>
          ) : null}
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
            { key: 'risk', label: uxText('chronos_risk', locale), width: '6rem' },
          ]}
          rows={items}
          rowKey={selectionKey}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          empty={uxText('chronos_approvals_empty', locale)}
          renderCell={(item, key, select) =>
            key === 'title' ? (
              <div className="flex flex-col gap-0.5">
                <WsTitleCell
                  title={item.title}
                  id={
                    (approvalTenantLabel(item, locale) ||
                      uxText('chronos_org_not_configured', locale)) +
                    ' / ' +
                    (item.kind || kindFallback)
                  }
                  onSelect={select}
                  selected={selectedKey === selectionKey(item)}
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
            <StatusPill
              status={
                selected.status === 'approved'
                  ? 'completed'
                  : selected.status === 'pending'
                    ? 'pending'
                    : 'blocked'
              }
              label={approvalStatusLabel(selected.status, locale)}
            />
            <Badge
              label={
                uxText('chronos_risk', locale) +
                ': ' +
                approvalRiskLabel(selected.risk?.level, locale)
              }
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
          {learningReview ? (
            <p className="kb-text kb-text--muted">
              {uxText('chronos_learning_review_only', locale)}
            </p>
          ) : (
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
                        selected.risk?.restartScope ||
                        uxText('chronos_approval_not_needed', locale),
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
                        selected.risk?.policyId ||
                        uxText('chronos_approval_default_policy', locale),
                      mono: Boolean(selected.risk?.policyId),
                    },
                  ]}
                />
              </div>
            </div>
          )}
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
                value: approvalTenantLabel(selected, locale) || '-',
                mono: true,
              },
              {
                label: uxText('chronos_project', locale),
                value: approvalProjectId(selected) || '-',
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
              disabled={busy || !fresh || !localAdmin || selected.status !== 'pending'}
              onClick={() => void decide('approved')}
            />
            <Button
              label={uxText('chronos_reject', locale)}
              variant="danger"
              disabled={busy || !fresh || !localAdmin || selected.status !== 'pending'}
              onClick={() => void decide('rejected')}
            />
          </div>
          {!localAdmin ? (
            <p className="kb-text kb-text--muted">{uxText('chronos_admin_action_hint', locale)}</p>
          ) : null}
        </Section>
      ) : (
        <Section>
          <EmptyState
            title={uxText(
              requestedId ? 'chronos_learning_review_unavailable' : 'chronos_select_approval',
              locale
            )}
          />
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
