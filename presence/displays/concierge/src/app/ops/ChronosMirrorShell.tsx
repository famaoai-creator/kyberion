'use client';

import { DiscussionRoom } from '../../components/ops/DiscussionRoom';
import { Suspense, useCallback, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import {
  A2UIActionProvider,
  Button,
  Callout,
  KeyValue,
  Metric,
  PageHeader,
  Section,
  Table,
  TextField,
  StatusPill,
  Tabs,
  type A2UILinkProps,
} from '@agent/shared-ui';
import { ChronosMirrorLegacySections } from './ChronosMirrorLegacySections';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import {
  CHRONOS_ACTIONS,
  CHRONOS_NAV_GROUPS,
  type ConsoleContentSection,
  type ConsoleSectionId,
} from './chronos-page-config';
import { humanizeMissionId } from '../../components/ops/ChronosOffice';
import { ChronosKbI18n } from '../../components/ops/chronos-kb-i18n';
import { ChronosFieldScope, ChronosInline, ChronosToolbar } from '../../components/ops/chronos-ui';
import type { KbStatus } from '@agent/core/surface/a2ui-catalog';
import { uxText as uxTextStatic, type SupportedLocale } from '../../lib/ops/ux-vocabulary';
import { costAmountLabel, referenceAmountLabel } from '../../lib/ops/cost-summary-presentation';

type ViewModel = Record<string, any>;

/** Connection review decision → canonical `ui:status-pill` status. */
const CONNECTION_REVIEW_STATUS: Record<string, KbStatus> = {
  pending: 'pending',
  approve: 'ready',
  modify: 'review',
  hold: 'paused',
  delete: 'stopped',
};

const CONNECTION_REVIEW_LABEL_KEY: Record<string, string> = {
  pending: 'chronos_connection_state_pending',
  approve: 'chronos_connection_state_approved',
  modify: 'chronos_connection_state_modify',
  hold: 'chronos_connection_state_hold',
  delete: 'chronos_connection_state_deleted',
};

function connectionReviewLabel(action: unknown, locale: SupportedLocale): string {
  const key =
    CONNECTION_REVIEW_LABEL_KEY[typeof action === 'string' && action ? action : 'pending'];
  return key ? uxTextStatic(key, locale) : String(action);
}

function NextKbLink({ href, children, ...rest }: A2UILinkProps) {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}

/**
 * UI-07: the shared-ui providers for every Chronos page — the renderer
 * locale + `ui:*` message bundle (ChronosKbI18n, same vocabulary catalog as
 * uxText), `next/link` for kb links, and one action handler for kb buttons
 * and form controls.
 */
function ChronosUiProviders({
  onAction,
  children,
}: {
  onAction: (actionId: string, payload?: Record<string, unknown>) => void;
  children: ReactNode;
}) {
  return (
    <ChronosKbI18n>
      <A2UIActionProvider onAction={onAction} linkComponent={NextKbLink}>
        {children}
      </A2UIActionProvider>
    </ChronosKbI18n>
  );
}

/** `--*` custom properties only, like `ui:app-shell`. */
function customPropertiesOnly(style: unknown): CSSProperties | undefined {
  if (!style || typeof style !== 'object') return undefined;
  const entries = Object.entries(style as Record<string, unknown>).filter(
    ([key, value]) =>
      key.startsWith('--') && (typeof value === 'string' || typeof value === 'number')
  );
  return entries.length ? (Object.fromEntries(entries) as CSSProperties) : undefined;
}

/**
 * The console's content frame (MSN-SHELL-IA §5): one `.kb-page` inside
 * Concierge's shell — no second `.kb-app-shell__main` and no forced density,
 * so /ops has the same frame, padding and density as every other page. The
 * `chronos-shell` / `data-role` hooks stay for the console stylesheet.
 */
function OpsShellFrame({ style, children }: { style?: unknown; children: ReactNode }) {
  return (
    <div
      className="kb-page chronos-shell"
      data-width="wide"
      data-role="chronos-mirror-v2"
      style={customPropertiesOnly(style)}
    >
      {children}
    </div>
  );
}

export function ChronosMirrorShell({ model }: { model: ViewModel }) {
  const {
    locale,
    agentPanelOpen,
    setAgentPanelOpen,
    tenantCssVars,
    setTenantCssVars,
    setTenantLabel,
    selectedMissionId,
    setSelectedMissionId,
    costSummary,
    costSummaryError,
    connections,
    connectionsError,
    setConnectionsError,
    connectionsQuery,
    setConnectionsQuery,
    connectionReviewBusyId,
    connectionReviewNote,
    setConnectionReviewNote,
    selectedConnectionId,
    setSelectedConnectionId,
    consoleSection,
    surfaceOrigin,
    openConsoleSection,
    submitConnectionReview,
    handleScenarioOpen,
    AgentPanel,
    IdentityBadge,
    chronosSpeechLocale,
    uxMessage,
    uxText,
    TenantDesignBridge,
    CONSOLE_SECTIONS,
  } = model;

  const { t } = useConciergeI18n();
  const activeSubSection: ConsoleContentSection =
    consoleSection === 'surface' ? surfaceOrigin : consoleSection;
  const sectionTabs = CHRONOS_NAV_GROUPS[0].sections.map((sectionId) => {
    const section = (CONSOLE_SECTIONS as Array<{ id: string; labelKey: string }>).find(
      (entry) => entry.id === sectionId
    );
    return { id: sectionId, label: uxText(section?.labelKey || sectionId, locale) };
  });

  // kb buttons (NextAction, …) report here.
  const handleUiAction = useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId === CHRONOS_ACTIONS.openSection && typeof payload?.section === 'string') {
        openConsoleSection(payload.section as ConsoleSectionId);
      } else if (
        actionId === CHRONOS_ACTIONS.openScenario &&
        typeof payload?.targetId === 'string'
      ) {
        handleScenarioOpen(payload.targetId, 'mission-intelligence');
      }
    },
    [handleScenarioOpen, openConsoleSection]
  );

  return (
    <Suspense fallback={null}>
      <TenantDesignBridge
        onResolve={(cssVars: Record<string, string>, label: string | null) => {
          setTenantCssVars(cssVars);
          setTenantLabel(label);
        }}
      />
      <ChronosUiProviders onAction={handleUiAction}>
        {/* Inside Concierge the Concierge shell (front-desk rail + header)
            wraps /ops, so the console renders as a content frame, not a
            second app shell. Tenant design overrides (customerId / brandName
            deep links) only: `--*` custom properties, anything else dropped. */}
        <OpsShellFrame style={tenantCssVars}>
          {/* One page title (the shell header carries the product identity);
              the scope comes from the shell's workspace switcher. */}
          <PageHeader
            title={t('ia_shell_ops_title')}
            subtitle={t('ia_shell_ops_subtitle')}
            actions={[
              {
                label: uxText('chronos_agent_runtimes', locale),
                onClick: () => setAgentPanelOpen(true),
              },
            ]}
          >
            <IdentityBadge />
          </PageHeader>

          <div className="chronos-nav">
            <Tabs
              items={sectionTabs}
              active={activeSubSection}
              label={uxText('chronos_group_operate', locale)}
              onSelect={(sectionId) => openConsoleSection(sectionId as ConsoleSectionId)}
            />
          </div>

          {consoleSection === 'diagnostics' ? (
            <div className="chronos-two-col">
              <Section
                title={uxText('chronos_diagnostics_cost_title', locale)}
                description={
                  selectedMissionId
                    ? `${uxText('chronos_diagnostics_cost', locale)} · ${selectedMissionId}`
                    : `${uxText('chronos_diagnostics_cost', locale)} · ${uxText('chronos_today', locale)}`
                }
              >
                {costSummaryError ? <Callout tone="danger" title={costSummaryError} /> : null}
                {costSummary && costSummary.costComplete !== true ? (
                  <Callout
                    tone="warning"
                    title={uxText('chronos_cost_unknown', locale)}
                    body={
                      costSummary.unknownCostCalls > 0
                        ? uxMessage(
                            'chronos_cost_incomplete',
                            { count: String(costSummary.unknownCostCalls) },
                            '',
                            locale
                          )
                        : uxText('chronos_cost_coverage_unavailable', locale)
                    }
                  />
                ) : null}
                <div className="chronos-metrics">
                  <Metric
                    label={uxText('chronos_cost_known_subtotal', locale)}
                    value={costAmountLabel(costSummary?.totalUsd, costSummary, locale)}
                    description={`${costSummary?.entryCount || 0} ${uxText('chronos_diagnostics_entries', locale)}`}
                  />
                  <Metric
                    label={uxText('chronos_cost_reference', locale)}
                    value={referenceAmountLabel(costSummary, locale)}
                    description={uxText('chronos_cost_reference_hint', locale)}
                  />
                  {costSummary?.includedCalls > 0 ? (
                    <Metric
                      label={uxText('chronos_cost_included', locale)}
                      value={String(costSummary.includedCalls)}
                      description={uxMessage(
                        'chronos_cost_included_hint',
                        { count: String(costSummary.includedCalls) },
                        '',
                        locale
                      )}
                    />
                  ) : null}
                  <Metric
                    label={uxText('chronos_diagnostics_tokens', locale)}
                    value={
                      typeof costSummary?.totalTokens === 'number'
                        ? costSummary.totalTokens.toLocaleString(chronosSpeechLocale())
                        : '-'
                    }
                    description={
                      typeof costSummary?.withheldPartitions === 'number' &&
                      costSummary.withheldPartitions > 0
                        ? uxMessage(
                            'chronos_diagnostics_metrics_partial',
                            { count: String(costSummary.withheldPartitions) },
                            'Partial: {count} metrics partition(s) withheld for this persona',
                            locale
                          )
                        : costSummary?.partialNotice ||
                          `${costSummary?.missionCount || 0} ${uxText('chronos_diagnostics_missions', locale)}`
                    }
                  />
                  <Metric
                    label={uxText('chronos_diagnostics_budget', locale)}
                    value={
                      typeof costSummary?.budgetUsd === 'number'
                        ? `$${costSummary.budgetUsd.toFixed(3)}`
                        : uxText('chronos_diagnostics_budget_unset', locale)
                    }
                    description={
                      costSummary && costSummary.costComplete !== true
                        ? uxText('chronos_cost_budget_unknown', locale)
                        : typeof costSummary?.remainingUsd === 'number'
                          ? uxMessage(
                              'chronos_diagnostics_budget_remaining',
                              { amount: `$${costSummary.remainingUsd.toFixed(3)}` },
                              'remaining {amount}',
                              locale
                            )
                          : uxText('chronos_no_budget_guard', locale)
                    }
                  />
                  <Metric
                    label={uxText('chronos_diagnostics_generation_actual', locale)}
                    value={
                      typeof costSummary?.generation?.actualUsd === 'number'
                        ? `$${costSummary.generation.actualUsd.toFixed(3)}`
                        : '-'
                    }
                    tone={costSummary?.generation?.awaitingActualCost ? 'warning' : undefined}
                    description={
                      costSummary?.generation?.awaitingActualCost
                        ? `${costSummary.generation.awaitingActualCost} ${uxText('chronos_diagnostics_generation_pending', locale)}`
                        : `${costSummary?.generation?.settledJobs || 0} ${uxText('chronos_diagnostics_entries', locale)}`
                    }
                  />
                </div>
                {Array.isArray(costSummary?.missionBreakdown) &&
                costSummary.missionBreakdown.length > 0 ? (
                  <Table
                    columns={[
                      { key: 'mission', label: uxText('chronos_col_mission', locale) },
                      {
                        key: 'usd',
                        label: uxText('chronos_cost_known_subtotal', locale),
                        align: 'end',
                      },
                      {
                        key: 'tokens',
                        label: uxText('chronos_diagnostics_tokens', locale),
                        align: 'end',
                      },
                      {
                        key: 'entries',
                        label: uxText('chronos_diagnostics_entries', locale),
                        align: 'end',
                      },
                    ]}
                    row_key="id"
                    rows={costSummary.missionBreakdown.slice(0, 4).map((item: any) => ({
                      id: item.missionId,
                      mission: (
                        <span className="chronos-mission-cell">
                          <button
                            type="button"
                            className="chronos-mission-cell__title"
                            aria-pressed={selectedMissionId === item.missionId}
                            onClick={() =>
                              setSelectedMissionId(
                                item.missionId === 'UNASSIGNED' ? null : item.missionId
                              )
                            }
                          >
                            {item.missionId === 'UNASSIGNED'
                              ? uxText('chronos_diagnostics_unassigned', locale)
                              : humanizeMissionId(item.missionId)}
                          </button>
                          {item.missionId === 'UNASSIGNED' ? null : (
                            <span className="chronos-mission-cell__id">{item.missionId}</span>
                          )}
                        </span>
                      ),
                      usd: costAmountLabel(item.usd, item, locale),
                      tokens: item.tokens.toLocaleString(chronosSpeechLocale()),
                      entries: item.entryCount,
                    }))}
                  />
                ) : null}
              </Section>

              <Section
                title={uxText('chronos_connection_review', locale)}
                description={uxText('chronos_connection_check', locale)}
              >
                <ChronosFieldScope
                  onChange={(name, value) => {
                    if (name === 'connections_query')
                      setConnectionsQuery(typeof value === 'string' ? value : '');
                  }}
                >
                  <ChronosToolbar>
                    <TextField
                      name="connections_query"
                      type="search"
                      label={uxText('chronos_search', locale)}
                      hide_label
                      placeholder={uxText('chronos_search', locale)}
                      value={connectionsQuery}
                    />
                  </ChronosToolbar>
                </ChronosFieldScope>
                {connectionsError ? <Callout tone="danger" title={connectionsError} /> : null}
                <Table
                  columns={[
                    { key: 'service', label: uxText('chronos_connection_col_service', locale) },
                    { key: 'scope', label: uxText('chronos_connection_col_scope', locale) },
                    { key: 'review', label: uxText('chronos_col_status', locale), width: '9rem' },
                    {
                      key: 'select',
                      label: uxText('chronos_connection_col_actions', locale),
                      align: 'end',
                    },
                  ]}
                  row_key="id"
                  empty={uxText('chronos_connection_empty', locale)}
                  rows={connections
                    .filter((item: any) => {
                      if (!connectionsQuery.trim()) return true;
                      const haystack = [
                        item.binding_id,
                        item.service_id,
                        item.service_type,
                        item.scope,
                        item.target,
                        item.reviewAction,
                        item.reviewNote,
                      ]
                        .filter(Boolean)
                        .join(' ')
                        .toLowerCase();
                      return haystack.includes(connectionsQuery.trim().toLowerCase());
                    })
                    .map((item: any) => ({
                      id: item.binding_id,
                      service: {
                        title: `${item.service_id || item.target}${item.service_type ? ` · ${item.service_type}` : ''}`,
                        id: item.binding_id,
                      },
                      scope: `${item.scope || '-'} → ${item.target || '-'}`,
                      review: (
                        <StatusPill
                          status={
                            CONNECTION_REVIEW_STATUS[item.reviewAction || 'pending'] || 'pending'
                          }
                          label={connectionReviewLabel(item.reviewAction, locale)}
                        />
                      ),
                      select: (
                        <Button
                          variant={selectedConnectionId === item.binding_id ? 'primary' : 'ghost'}
                          label={uxText('chronos_connection_select', locale)}
                          onClick={() => {
                            setSelectedConnectionId(item.binding_id);
                            setConnectionsError(null);
                          }}
                        />
                      ),
                    }))}
                />
                {selectedConnectionId
                  ? (() => {
                      const selected = connections.find(
                        (item: any) => item.binding_id === selectedConnectionId
                      );
                      if (!selected) {
                        return (
                          <p className="kb-text kb-text--muted">
                            {uxText('chronos_connection_not_found', locale)}
                          </p>
                        );
                      }
                      const busy = connectionReviewBusyId === selected.binding_id;
                      return (
                        <Section
                          headingLevel={3}
                          title={selected.service_id || selected.binding_id}
                          description={connectionReviewLabel(selected.reviewAction, locale)}
                        >
                          <KeyValue
                            items={[
                              {
                                label: uxText('chronos_connection_col_scope', locale),
                                value: selected.scope || '-',
                              },
                              {
                                label: uxText('chronos_connection_target', locale),
                                value: selected.target || '-',
                                mono: true,
                              },
                              {
                                label: uxText('chronos_connection_policy', locale),
                                value: Object.keys(selected.approval_policy || {}).length,
                              },
                              {
                                label: uxText('chronos_connection_reviewed_at', locale),
                                value: selected.reviewedAt || '-',
                              },
                            ]}
                          />
                          <label className="kb-field" data-control="textarea">
                            <span className="kb-field__label">
                              {uxText('chronos_connection_review_note', locale)}
                            </span>
                            <textarea
                              className="kb-input kb-textarea"
                              rows={3}
                              value={connectionReviewNote}
                              onChange={(event) => setConnectionReviewNote(event.target.value)}
                            />
                          </label>
                          <ChronosInline>
                            <Button
                              variant="primary"
                              disabled={busy}
                              label={uxText('chronos_connection_approve', locale)}
                              onClick={() => submitConnectionReview(selected.binding_id, 'approve')}
                            />
                            <Button
                              disabled={busy}
                              label={uxText('chronos_connection_modify', locale)}
                              onClick={() => submitConnectionReview(selected.binding_id, 'modify')}
                            />
                            <Button
                              disabled={busy}
                              label={uxText('chronos_connection_hold', locale)}
                              onClick={() => submitConnectionReview(selected.binding_id, 'hold')}
                            />
                            <Button
                              variant="danger"
                              disabled={busy}
                              label={uxText('chronos_connection_delete', locale)}
                              onClick={() => submitConnectionReview(selected.binding_id, 'delete')}
                            />
                          </ChronosInline>
                        </Section>
                      );
                    })()
                  : null}
              </Section>
            </div>
          ) : null}

          {consoleSection === 'discussion' ? <DiscussionRoom embedded /> : null}

          <ChronosMirrorLegacySections model={model} />

          <AgentPanel isOpen={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
        </OpsShellFrame>
      </ChronosUiProviders>
    </Suspense>
  );
}
