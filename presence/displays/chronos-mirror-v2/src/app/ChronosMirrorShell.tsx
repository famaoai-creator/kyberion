'use client';

import { Suspense, useCallback, type ReactNode } from 'react';
import Link from 'next/link';
import {
  A2UIActionProvider,
  Button,
  Callout,
  KeyValue,
  List,
  Metric,
  Section,
  Table,
  TextField,
  Textarea,
  isKbStatus,
  KB_FORM_ACTIONS,
  AppShell,
  type AppShellStyle,
  PageHeader,
  Segmented,
  Select,
  StatusPill,
  Tabs,
  type A2UILinkProps,
} from '@agent/shared-ui';
import { ChronosMirrorLegacySections } from './ChronosMirrorLegacySections';
import {
  CHRONOS_ACTIONS,
  CHRONOS_NAV_GROUPS,
  chronosNavGroupFor,
  type ConsoleContentSection,
  type ConsoleSectionId,
} from './chronos-page-config';
import { ChronosHome } from '../components/ChronosHome';
import { humanizeMissionId } from '../components/ChronosOffice';
import { ChronosKbI18n } from '../components/chronos-kb-i18n';
import { ChronosFieldScope, ChronosInline, ChronosToolbar } from '../components/chronos-ui';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import { uxText as uxTextStatic, type SupportedLocale } from '../lib/ux-vocabulary';
import type { ChronosThemeMode } from '../lib/chronos-theme';

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

/** Ask-why reason categories for a declined deliverable (category → label key). */
const DELIVERABLE_REASON_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['incorrect_content', 'chronos_dl_reason_incorrect_content'],
  ['wrong_direction', 'chronos_dl_reason_wrong_direction'],
  ['quality', 'chronos_dl_reason_quality'],
  ['scope', 'chronos_dl_reason_scope'],
  ['other', 'chronos_dl_reason_other'],
];

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

function normalizeThemeChoice(value: unknown): ChronosThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function ChronosMirrorShell({ model }: { model: ViewModel }) {
  const {
    locale,
    tenant,
    organizationId,
    projectId,
    agentPanelOpen,
    setAgentPanelOpen,
    missionIntelligenceFocus,
    setMissionIntelligenceFocus,
    missionIntelligenceFocusedMissionId,
    setMissionIntelligenceFocusedMissionId,
    tenantCssVars,
    setTenantCssVars,
    setTenantLabel,
    themeModePreference,
    setThemeModePreference,
    planRequestText,
    setPlanRequestText,
    planMissionType,
    setPlanMissionType,
    planPersona,
    setPlanPersona,
    planTier,
    setPlanTier,
    planPreview,
    planPreviewError,
    planPreviewBusy,
    deliverables,
    deliverablesError,
    deliverablesQuery,
    setDeliverablesQuery,
    selectedDeliverableId,
    setSelectedDeliverableId,
    deliverableReviewComment,
    setDeliverableReviewComment,
    deliverableReviewBusy,
    deliverableReviewError,
    setDeliverableReviewError,
    deliverableAskWhyVerdict,
    operatorHomeSummary,
    operatorHomeError,
    missionHistory,
    missionHistoryError,
    missionHistoryQuery,
    setMissionHistoryQuery,
    missionHistoryStatus,
    setMissionHistoryStatus,
    missionHistoryTier,
    setMissionHistoryTier,
    selectedMissionId,
    setSelectedMissionId,
    costSummary,
    costSummaryError,
    planApprovalBusy,
    planApprovalMessage,
    setPlanApprovalMessage,
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
    showCleanedDeliverables,
    setShowCleanedDeliverables,
    planPreviewIsStale,
    handleReady,
    handleA2UIMessage,
    consoleSection,
    surfaceOrigin,
    openConsoleSection,
    openDeliverableAsset,
    runPlanPreview,
    approvePlanAndStart,
    submitDeliverableReview,
    submitConnectionReview,
    handleOperatorViewOpen,
    handleScenarioOpen,
    cleanedDeliverableCount,
    visibleDeliverables,
    homeCounters,
    missionTitles,
    KbArtifactTile,
    KbInterventionPanel,
    SovereignChat,
    AgentPanel,
    FirstRunBanner,
    IdentityBadge,
    MissionIntelligence,
    MissionJourneySummary,
    CloudflareOsPanel,
    ApprovalsWorkspace,
    DeliverablesWorkspace,
    KnowledgeWorkspace,
    ChronosTenantScope,
    chronosSpeechLocale,
    setChronosLocalePreference,
    uxMessage,
    uxText,
    TenantDesignBridge,
    CONSOLE_SECTIONS,
  } = model;

  const activeGroupId = chronosNavGroupFor(
    consoleSection as ConsoleSectionId,
    surfaceOrigin as ConsoleContentSection
  );
  const activeGroup =
    CHRONOS_NAV_GROUPS.find((group) => group.id === activeGroupId) ?? CHRONOS_NAV_GROUPS[0];
  const activeSubSection: ConsoleContentSection =
    consoleSection === 'surface' ? surfaceOrigin : consoleSection;
  const pendingApprovals = Number(operatorHomeSummary?.counts?.pendingApprovals || 0);
  const groupTabs = CHRONOS_NAV_GROUPS.map((group) => ({
    id: group.id,
    label: uxText(group.labelKey, locale),
    ...(group.id === 'decide' && pendingApprovals > 0 ? { count: pendingApprovals } : {}),
  }));
  const subTabs = activeGroup.sections.map((sectionId) => {
    const section = (CONSOLE_SECTIONS as Array<{ id: string; labelKey: string }>).find(
      (entry) => entry.id === sectionId
    );
    return { id: sectionId, label: uxText(section?.labelKey || sectionId, locale) };
  });

  // kb buttons (NextAction, …) and the header's form controls report here.
  const handleUiAction = useCallback(
    (actionId: string, payload?: Record<string, unknown>) => {
      if (actionId === CHRONOS_ACTIONS.openSection && typeof payload?.section === 'string') {
        openConsoleSection(payload.section as ConsoleSectionId);
      } else if (
        actionId === CHRONOS_ACTIONS.openScenario &&
        typeof payload?.targetId === 'string'
      ) {
        handleScenarioOpen(payload.targetId, 'mission-intelligence');
      } else if (actionId === KB_FORM_ACTIONS.fieldChange && payload) {
        if (payload.name === 'theme') {
          setThemeModePreference(normalizeThemeChoice(payload.value));
        } else if (
          payload.name === 'locale' &&
          (payload.value === 'ja' || payload.value === 'en')
        ) {
          setChronosLocalePreference(payload.value);
        }
      }
    },
    [handleScenarioOpen, openConsoleSection, setThemeModePreference, setChronosLocalePreference]
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
        {/* Tenant design overrides (customerId / brandName deep links) only:
            AppShell keeps `--*` custom properties and drops anything else. */}
        <AppShell
          density="compact"
          role="chronos-mirror-v2"
          className="chronos-shell"
          style={tenantCssVars as AppShellStyle}
        >
          <div className="chronos-header">
            <PageHeader
              title={uxText('chronos_cb_role', locale)}
              subtitle={uxText('chronos_surface_role_tagline', locale)}
              role_badge={{
                label: uxText('chronos_shell_role_badge', locale),
                role: 'chronos-mirror-v2',
              }}
            >
              <div className="chronos-header__controls">
                <Segmented
                  name="theme"
                  label={uxText('chronos_theme_label', locale)}
                  hide_label
                  value={themeModePreference}
                  options={[
                    { value: 'system', label: uxText('chronos_theme_auto', locale) },
                    { value: 'light', label: uxText('chronos_theme_light', locale) },
                    { value: 'dark', label: uxText('chronos_theme_dark', locale) },
                  ]}
                />
                <Select
                  name="locale"
                  label={uxText('chronos_locale_label', locale)}
                  hide_label
                  value={locale}
                  options={[
                    { value: 'ja', label: uxText('chronos_locale_ja', locale) },
                    { value: 'en', label: uxText('chronos_locale_en', locale) },
                  ]}
                />
                <IdentityBadge />
                <Button
                  label={uxText('chronos_agent_runtimes', locale)}
                  onClick={() => setAgentPanelOpen(true)}
                />
              </div>
            </PageHeader>
            <ChronosTenantScope compact />
          </div>

          <div className="chronos-nav">
            <Tabs
              items={groupTabs}
              active={activeGroup.id}
              label={uxText('chronos_nav_groups_label', locale)}
              onSelect={(groupId) => {
                const group = CHRONOS_NAV_GROUPS.find((entry) => entry.id === groupId);
                if (group) openConsoleSection(group.sections[0]);
              }}
            />
            {subTabs.length > 1 ? (
              <Tabs
                variant="secondary"
                items={subTabs}
                active={activeSubSection}
                label={uxText(activeGroup.labelKey, locale)}
                onSelect={(sectionId) => openConsoleSection(sectionId as ConsoleSectionId)}
              />
            ) : null}
          </div>

          {consoleSection === 'home' ? (
            <>
              <ChronosHome
                tenant={tenant}
                summary={operatorHomeSummary}
                summaryError={operatorHomeError}
                counters={homeCounters}
                missionTitles={missionTitles}
                onOpenScenario={(targetId) => handleScenarioOpen(targetId, 'mission-intelligence')}
                onOpenMission={(missionId) =>
                  handleOperatorViewOpen('mission-control-plane', missionId)
                }
              />
              <MissionJourneySummary
                summary={operatorHomeSummary}
                onOpenMissions={() => openConsoleSection('missions')}
                onOpenOperations={() => openConsoleSection('operations')}
              />
              <CloudflareOsPanel missionId={selectedMissionId} />
              <FirstRunBanner />
            </>
          ) : null}

          {consoleSection === 'missions' ? (
            <Section
              title={uxText('chronos_missions_history_title', locale)}
              description={uxText('chronos_missions_history_eyebrow', locale)}
            >
              <ChronosFieldScope
                onChange={(name, value) => {
                  const text = typeof value === 'string' ? value : '';
                  if (name === 'mission_history_query') setMissionHistoryQuery(text);
                  else if (name === 'mission_history_status') setMissionHistoryStatus(text);
                  else if (name === 'mission_history_tier') setMissionHistoryTier(text);
                }}
              >
                <ChronosToolbar>
                  <TextField
                    name="mission_history_query"
                    type="search"
                    label={uxText('chronos_search', locale)}
                    hide_label
                    placeholder={uxText('chronos_search', locale)}
                    value={missionHistoryQuery}
                  />
                  <Select
                    name="mission_history_status"
                    label={uxText('chronos_col_status', locale)}
                    hide_label
                    value={missionHistoryStatus}
                    options={[
                      { value: '', label: uxText('chronos_mh_all_statuses', locale) },
                      { value: 'completed', label: uxText('chronos_status_completed', locale) },
                      { value: 'active', label: uxText('chronos_status_active', locale) },
                      { value: 'paused', label: uxText('chronos_status_paused', locale) },
                      { value: 'failed', label: uxText('chronos_status_failed', locale) },
                    ]}
                  />
                  <Select
                    name="mission_history_tier"
                    label={uxText('chronos_data_level_field', locale)}
                    hide_label
                    value={missionHistoryTier}
                    options={[
                      { value: '', label: uxText('chronos_all_tiers', locale) },
                      { value: 'public', label: uxText('chronos_tier_public', locale) },
                      { value: 'confidential', label: uxText('chronos_tier_confidential', locale) },
                      { value: 'personal', label: uxText('chronos_tier_personal', locale) },
                    ]}
                  />
                </ChronosToolbar>
              </ChronosFieldScope>
              {missionHistoryError ? <Callout tone="danger" title={missionHistoryError} /> : null}
              <div className="chronos-scroll-area chronos-scroll">
                <Table
                  columns={[
                    { key: 'mission', label: uxText('chronos_col_mission', locale) },
                    { key: 'status', label: uxText('chronos_col_status', locale), width: '8rem' },
                    { key: 'type', label: uxText('chronos_mission_type', locale) },
                    { key: 'artifacts', label: uxText('chronos_mission_artifacts', locale) },
                    { key: 'tier', label: uxText('chronos_mission_tier', locale) },
                    { key: 'updated', label: uxText('chronos_updated', locale), mono: true },
                  ]}
                  row_key="id"
                  empty={uxText('chronos_mh_no_match', locale)}
                  rows={missionHistory.map((mission: any) => {
                    const typeLabel =
                      mission.missionType === 'product_delivery'
                        ? uxText('chronos_mission_type_product_delivery', locale)
                        : mission.missionType || '-';
                    return {
                      id: mission.missionId,
                      mission: (
                        <span className="chronos-mission-cell">
                          <button
                            type="button"
                            className="chronos-mission-cell__title"
                            aria-pressed={selectedMissionId === mission.missionId}
                            onClick={() => {
                              setSelectedMissionId(mission.missionId);
                              setMissionIntelligenceFocusedMissionId(mission.missionId);
                            }}
                          >
                            {mission.goalSummary ||
                              mission.intentText ||
                              (mission.missionType === 'product_delivery'
                                ? typeLabel
                                : humanizeMissionId(mission.missionId))}
                          </button>
                          <span className="chronos-mission-cell__id">
                            {mission.missionId}
                            {mission.tenantSlug || mission.tenantId
                              ? ` · ${mission.tenantSlug || mission.tenantId}`
                              : ''}
                          </span>
                          {mission.successCondition ? (
                            <span className="chronos-meta">{mission.successCondition}</span>
                          ) : null}
                        </span>
                      ),
                      status: isKbStatus(mission.status)
                        ? { status: mission.status }
                        : mission.status || '-',
                      type: typeLabel,
                      artifacts: `${mission.artifactCount || 0}${
                        mission.artifactKinds?.length
                          ? ` · ${mission.artifactKinds.slice(0, 3).join(', ')}`
                          : ''
                      }`,
                      tier: mission.tier || '-',
                      updated: mission.updatedAt || mission.startedAt || '-',
                    };
                  })}
                />
              </div>
            </Section>
          ) : null}

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
                <div className="chronos-metrics">
                  <Metric
                    label={uxText('chronos_diagnostics_currency', locale)}
                    value={
                      typeof costSummary?.totalUsd === 'number'
                        ? `$${costSummary.totalUsd.toFixed(3)}`
                        : '-'
                    }
                    description={`${costSummary?.entryCount || 0} ${uxText('chronos_diagnostics_entries', locale)}`}
                  />
                  <Metric
                    label={uxText('chronos_diagnostics_tokens', locale)}
                    value={
                      typeof costSummary?.totalTokens === 'number'
                        ? costSummary.totalTokens.toLocaleString(chronosSpeechLocale())
                        : '-'
                    }
                    description={`${costSummary?.missionCount || 0} ${uxText('chronos_diagnostics_missions', locale)}`}
                  />
                  <Metric
                    label={uxText('chronos_diagnostics_budget', locale)}
                    value={
                      typeof costSummary?.budgetUsd === 'number'
                        ? `$${costSummary.budgetUsd.toFixed(3)}`
                        : uxText('chronos_diagnostics_budget_unset', locale)
                    }
                    description={
                      typeof costSummary?.remainingUsd === 'number'
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
                        label: uxText('chronos_diagnostics_currency', locale),
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
                      usd: `$${item.usd.toFixed(3)}`,
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

          {consoleSection === 'missions' ? (
            <div className="chronos-two-col">
              <Section
                title={uxText('chronos_mission_plan_title', locale)}
                description={uxText('chronos_plan_description', locale)}
                actions={[
                  {
                    label: planPreviewBusy
                      ? uxText('chronos_previewing', locale)
                      : uxText('chronos_preview', locale),
                    disabled: planPreviewBusy,
                    onClick: () => runPlanPreview(),
                  },
                  {
                    label: planApprovalBusy
                      ? uxText('chronos_starting', locale)
                      : uxText('chronos_approve_start', locale),
                    variant: 'primary',
                    disabled: planApprovalBusy || !planPreview || planPreviewIsStale,
                    onClick: () => approvePlanAndStart(),
                  },
                ]}
              >
                {planPreview && planPreviewIsStale ? (
                  <Callout tone="warning" title={uxText('chronos_preview_stale', locale)} />
                ) : null}
                <ChronosFieldScope
                  onChange={(name, value) => {
                    const text = typeof value === 'string' ? value : '';
                    if (name === 'plan_request') setPlanRequestText(text);
                    else if (name === 'plan_mission_type') setPlanMissionType(text);
                    else if (name === 'plan_persona') setPlanPersona(text);
                    else if (
                      name === 'plan_tier' &&
                      (text === 'personal' || text === 'confidential' || text === 'public')
                    )
                      setPlanTier(text);
                  }}
                >
                  <Textarea
                    name="plan_request"
                    label={uxText('chronos_plan_request_label', locale)}
                    placeholder={uxText('chronos_plan_request_placeholder', locale)}
                    rows={4}
                    value={planRequestText}
                  />
                  <div className="chronos-form-row">
                    <TextField
                      name="plan_mission_type"
                      label={uxText('chronos_mission_type_field', locale)}
                      value={planMissionType}
                    />
                    <TextField
                      name="plan_persona"
                      label={uxText('chronos_persona_field', locale)}
                      value={planPersona}
                    />
                    <Select
                      name="plan_tier"
                      label={uxText('chronos_data_level_field', locale)}
                      value={planTier}
                      options={[
                        { value: 'personal', label: uxText('chronos_tier_personal', locale) },
                        {
                          value: 'confidential',
                          label: uxText('chronos_tier_confidential', locale),
                        },
                        { value: 'public', label: uxText('chronos_tier_public', locale) },
                      ]}
                    />
                  </div>
                </ChronosFieldScope>
                {planPreviewError ? <Callout tone="danger" title={planPreviewError} /> : null}
                {planApprovalMessage ? (
                  <Callout tone="success" title={planApprovalMessage} />
                ) : null}
                {planPreview ? (
                  <>
                    <Section
                      headingLevel={3}
                      title={planPreview.goal?.summary || uxText('chronos_mission_goal', locale)}
                      description={planPreview.goal?.successCondition}
                    >
                      <KeyValue
                        items={[
                          {
                            label: uxText('chronos_plan_delivery_mode', locale),
                            value: planPreview.delivery?.mode || '-',
                            mono: true,
                          },
                          {
                            label: uxText('chronos_plan_clarification', locale),
                            value: planPreview.delivery?.clarificationNeeded
                              ? uxText('chronos_plan_clarification_needed', locale)
                              : uxText('chronos_plan_clarification_clear', locale),
                          },
                          {
                            label: uxText('chronos_plan_execution', locale),
                            value: planPreview.execution?.shape || '-',
                            mono: true,
                          },
                          {
                            label: uxText('chronos_plan_confidence', locale),
                            value: `${Math.round((Number(planPreview.confidence) || 0) * 100)}%`,
                          },
                        ]}
                      />
                      {Array.isArray(planPreview.execution?.clarificationQuestions) &&
                      planPreview.execution.clarificationQuestions.length > 0 ? (
                        <KbInterventionPanel
                          reason={uxText('chronos_plan_clarification_reason', locale)}
                          isBlocking
                          options={planPreview.execution.clarificationQuestions.map(
                            (question: any) => ({
                              label: question.question,
                              variant: 'neutral' as const,
                              value: question.id,
                            })
                          )}
                          onSelectOption={(option: { label: string }) => {
                            setPlanRequestText(
                              (current: string) =>
                                `${current.trimEnd()}\n\n${uxText('chronos_plan_clarification_answer_prefix', locale)}${option.label}\n→ `
                            );
                            setPlanApprovalMessage(
                              uxText('chronos_plan_clarification_appended', locale)
                            );
                          }}
                        />
                      ) : null}
                    </Section>
                    <Section
                      headingLevel={3}
                      title={uxText('chronos_plan_team_title', locale)}
                      description={uxMessage(
                        'chronos_plan_team_counts',
                        {
                          assignments: planPreview.team?.assignments?.length || 0,
                          roles:
                            planPreview.team?.team_governance?.composition?.required_roles
                              ?.length || 0,
                        },
                        '{assignments} assignments · {roles} required roles',
                        locale
                      )}
                    >
                      <List
                        items={(planPreview.team?.assignments || [])
                          .slice(0, 5)
                          .map((assignment: any) => ({
                            title: assignment.team_role,
                            meta: `${assignment.agent_id || uxText('chronos_plan_unfilled', locale)}${
                              assignment.status ? ` · ${assignment.status}` : ''
                            }`,
                          }))}
                      />
                      <h4 className="chronos-feed__title">
                        {uxText('chronos_plan_workflow_steps', locale)}
                      </h4>
                      <List
                        variant="timeline"
                        items={(planPreview.workflow || []).slice(0, 5).map((step: any) => ({
                          title: step.label,
                          meta: step.description,
                        }))}
                      />
                    </Section>
                  </>
                ) : null}
              </Section>

              <Section
                title={uxText('chronos_deliverables_preview_title', locale)}
                description={uxText('chronos_deliverables_description', locale)}
              >
                <ChronosFieldScope
                  onChange={(name, value) => {
                    if (name === 'deliverables_query')
                      setDeliverablesQuery(typeof value === 'string' ? value : '');
                  }}
                >
                  <ChronosToolbar>
                    <TextField
                      name="deliverables_query"
                      type="search"
                      label={uxText('chronos_search', locale)}
                      hide_label
                      placeholder={uxText('chronos_search', locale)}
                      value={deliverablesQuery}
                    />
                    {cleanedDeliverableCount > 0 ? (
                      <Button
                        variant="ghost"
                        label={uxMessage(
                          showCleanedDeliverables
                            ? 'chronos_dl_hide_cleaned'
                            : 'chronos_dl_show_cleaned',
                          { count: cleanedDeliverableCount },
                          '{count} cleaned-up record(s)',
                          locale
                        )}
                        onClick={() => setShowCleanedDeliverables((current: boolean) => !current)}
                      />
                    ) : null}
                  </ChronosToolbar>
                </ChronosFieldScope>
                {deliverablesError ? <Callout tone="danger" title={deliverablesError} /> : null}
                <div className="chronos-scroll-area chronos-scroll chronos-stack">
                  {visibleDeliverables.length === 0 ? (
                    <p className="kb-text kb-text--muted">
                      {deliverables.length === 0
                        ? uxText('chronos_deliverables_empty', locale)
                        : uxText('chronos_dl_none_live', locale)}
                    </p>
                  ) : (
                    visibleDeliverables.map((item: any) => (
                      <KbArtifactTile
                        key={item.artifactId}
                        type={item.kind}
                        path={item.path || item.externalRef || item.artifactId}
                        missionId={item.missionId}
                        updatedAt={item.updatedAt}
                        missing={item.missing}
                        previewContent={[
                          item.previewText || item.kind,
                          item.integratedSummary ? `summary: ${item.integratedSummary}` : '',
                          ...(item.roleSections || []).map(
                            (section: { role: string; summary: string }) =>
                              `${section.role}: ${section.summary}`
                          ),
                          item.reviewVerdict ? `review: ${item.reviewVerdict}` : '',
                          item.reviewVersion ? `v${item.reviewVersion}` : '',
                          item.supersededCount
                            ? uxMessage(
                                'chronos_dl_superseded',
                                { count: item.supersededCount },
                                '+{count} older record(s) for the same file',
                                locale
                              )
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        onSelect={() => {
                          setSelectedDeliverableId(item.artifactId);
                          setDeliverableReviewError(null);
                        }}
                        onOpen={() => openDeliverableAsset(item)}
                        onPreview={() => openDeliverableAsset(item)}
                      />
                    ))
                  )}
                </div>
                {selectedDeliverableId
                  ? (() => {
                      const selected = deliverables.find(
                        (item: any) => item.artifactId === selectedDeliverableId
                      );
                      if (!selected) {
                        return (
                          <p className="kb-text kb-text--muted">
                            {uxText('chronos_dl_selected_not_found', locale)}
                          </p>
                        );
                      }
                      return (
                        <Section
                          headingLevel={3}
                          title={selected.artifactId}
                          description={
                            selected.reviewVerdict
                              ? `${uxText('chronos_updated', locale)}: ${selected.reviewVerdict}`
                              : uxText('chronos_not_reviewed', locale)
                          }
                        >
                          <p className="kb-text">{selected.previewText || selected.kind}</p>
                          <label className="kb-field" data-control="textarea">
                            <span className="kb-field__label">
                              {uxText('chronos_review_comment', locale)}
                            </span>
                            <textarea
                              className="kb-input kb-textarea"
                              rows={3}
                              value={deliverableReviewComment}
                              onChange={(event) => setDeliverableReviewComment(event.target.value)}
                            />
                          </label>
                          {deliverableReviewError ? (
                            <Callout tone="danger" title={deliverableReviewError} />
                          ) : null}
                          {deliverableAskWhyVerdict ? (
                            <Callout
                              tone="warning"
                              title={uxText('chronos_dl_ask_why_title', locale)}
                            >
                              <ChronosInline>
                                {DELIVERABLE_REASON_KEYS.map(([category, key]) => (
                                  <Button
                                    key={category}
                                    disabled={deliverableReviewBusy}
                                    label={uxTextStatic(key, locale)}
                                    onClick={() =>
                                      submitDeliverableReview(deliverableAskWhyVerdict, {
                                        reasonCategory: category,
                                      })
                                    }
                                  />
                                ))}
                                <Button
                                  variant="ghost"
                                  disabled={deliverableReviewBusy}
                                  label={uxText('chronos_dl_reason_skip', locale)}
                                  onClick={() =>
                                    submitDeliverableReview(deliverableAskWhyVerdict, {
                                      skipAskWhy: true,
                                    })
                                  }
                                />
                              </ChronosInline>
                            </Callout>
                          ) : null}
                          <ChronosInline>
                            <Button
                              variant="primary"
                              disabled={deliverableReviewBusy}
                              label={uxText('chronos_approve', locale)}
                              onClick={() => submitDeliverableReview('accept')}
                            />
                            <Button
                              disabled={deliverableReviewBusy}
                              label={uxText('chronos_request_changes', locale)}
                              onClick={() => submitDeliverableReview('request-changes')}
                            />
                            <Button
                              variant="danger"
                              disabled={deliverableReviewBusy}
                              label={uxText('chronos_reject', locale)}
                              onClick={() => submitDeliverableReview('reject')}
                            />
                          </ChronosInline>
                          <span className="chronos-meta" data-mono="true">
                            {uxMessage(
                              'chronos_dl_version',
                              { version: selected.reviewVersion || 1 },
                              'version {version}',
                              locale
                            )}
                            {selected.reviewCurrentArtifactId &&
                            selected.reviewCurrentArtifactId !== selected.artifactId
                              ? ` · ${selected.reviewCurrentArtifactId}`
                              : ''}
                          </span>
                        </Section>
                      );
                    })()
                  : null}
              </Section>
            </div>
          ) : null}

          {consoleSection === 'missions' ? (
            <MissionIntelligence
              tenant={tenant}
              workspace="missions"
              focusedView={missionIntelligenceFocus}
              focusedMissionId={selectedMissionId || missionIntelligenceFocusedMissionId}
              onClearFocus={() => {
                setMissionIntelligenceFocus(null);
                setMissionIntelligenceFocusedMissionId(null);
              }}
              showMissionIntelligenceLabel
              onOpenWorkspace={(target: ConsoleSectionId) => openConsoleSection(target)}
            />
          ) : null}

          {consoleSection === 'deliverables' ? (
            <DeliverablesWorkspace
              tenant={tenant || undefined}
              organizationId={organizationId || undefined}
              projectId={projectId || undefined}
              onOpenMission={(missionId) =>
                handleOperatorViewOpen('mission-control-plane', missionId)
              }
            />
          ) : null}

          {consoleSection === 'approvals' ? (
            <ApprovalsWorkspace tenant={tenant || undefined} />
          ) : null}

          {consoleSection === 'knowledge' ? (
            <KnowledgeWorkspace tenant={tenant || undefined} />
          ) : null}

          <ChronosMirrorLegacySections model={model} />

          {consoleSection === 'home' ? (
            <SovereignChat onA2UIMessage={handleA2UIMessage} onReady={handleReady} />
          ) : null}
          <AgentPanel isOpen={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
        </AppShell>
      </ChronosUiProviders>
    </Suspense>
  );
}
