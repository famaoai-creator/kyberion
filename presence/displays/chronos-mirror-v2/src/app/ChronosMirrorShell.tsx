'use client';

import { Suspense, useCallback, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import {
  A2UIActionProvider,
  Button,
  KB_FORM_ACTIONS,
  AppShell,
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
import type { ChronosThemeMode } from '../lib/chronos-theme';

type ViewModel = Record<string, any>;

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
    toneChipClass,
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
        {/* Tenant design overrides (customerId / brandName deep links) only. */}
        <div style={tenantCssVars as CSSProperties}>
          <AppShell density="compact" role="chronos-mirror-v2">
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
                <div className="chronos-subnav">
                  <Tabs
                    items={subTabs}
                    active={activeSubSection}
                    label={uxText(activeGroup.labelKey, locale)}
                    onSelect={(sectionId) => openConsoleSection(sectionId as ConsoleSectionId)}
                  />
                </div>
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
                  onOpenScenario={(targetId) =>
                    handleScenarioOpen(targetId, 'mission-intelligence')
                  }
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

            {(consoleSection === 'missions' || consoleSection === 'diagnostics') && (
              <section className={`grid gap-4 ${'xl:grid-cols-1'}`}>
                {consoleSection === 'missions' ? (
                  <div className="kyberion-glass rounded-xl border kb-border-subtle p-5 md:p-6">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] kb-text-accent">
                          {uxText('chronos_missions_history_eyebrow', locale)}
                        </div>
                        <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                          {uxText('chronos_missions_history_title', locale)}
                        </h2>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={missionHistoryQuery}
                          onChange={(event) => setMissionHistoryQuery(event.target.value)}
                          placeholder={uxText('chronos_search', locale)}
                          className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
                        />
                        <select
                          value={missionHistoryStatus}
                          onChange={(event) => setMissionHistoryStatus(event.target.value)}
                          className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] kb-text-secondary outline-none focus:kb-border-accent"
                        >
                          <option value="">{uxText('chronos_mh_all_statuses', locale)}</option>
                          <option value="completed">
                            {uxText('chronos_status_completed', locale)}
                          </option>
                          <option value="active">{uxText('chronos_status_active', locale)}</option>
                          <option value="paused">{uxText('chronos_status_paused', locale)}</option>
                          <option value="failed">{uxText('chronos_status_failed', locale)}</option>
                        </select>
                        <select
                          value={missionHistoryTier}
                          onChange={(event) => setMissionHistoryTier(event.target.value)}
                          className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] kb-text-secondary outline-none focus:kb-border-accent"
                        >
                          <option value="">{uxText('chronos_all_tiers', locale)}</option>
                          <option value="public">{uxText('chronos_tier_public', locale)}</option>
                          <option value="confidential">
                            {uxText('chronos_tier_confidential', locale)}
                          </option>
                          <option value="personal">
                            {uxText('chronos_tier_personal', locale)}
                          </option>
                        </select>
                      </div>
                    </div>
                    {missionHistoryError ? (
                      <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                        {missionHistoryError}
                      </div>
                    ) : null}
                    <div className="mt-4 max-h-[420px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                      {missionHistory.length === 0 ? (
                        <div className="rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] kb-text-muted">
                          {uxText('chronos_mh_no_match', locale)}
                        </div>
                      ) : (
                        missionHistory.map((mission) => (
                          <button
                            key={mission.missionId}
                            type="button"
                            onClick={() => {
                              setSelectedMissionId(mission.missionId);
                              setMissionIntelligenceFocusedMissionId(mission.missionId);
                            }}
                            className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                              selectedMissionId === mission.missionId
                                ? 'kb-border-accent kb-surface-accent'
                                : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="chronos-mission-cell">
                                <span className="chronos-mission-cell__title">
                                  {mission.goalSummary ||
                                    mission.intentText ||
                                    (mission.missionType === 'product_delivery'
                                      ? uxText('chronos_mission_type_product_delivery', locale)
                                      : humanizeMissionId(mission.missionId))}
                                </span>
                                <span className="chronos-mission-cell__id">
                                  {mission.missionId}
                                </span>
                              </div>
                              <StatusPill status={mission.status} />
                            </div>
                            <div className="mt-2 grid gap-2 text-[11px] kb-text-muted sm:grid-cols-2">
                              <div>
                                {uxText('chronos_mission_goal', locale)}:{' '}
                                <span className="kb-text-secondary">
                                  {mission.goalSummary ||
                                    mission.intentText ||
                                    mission.successCondition ||
                                    '-'}
                                </span>
                              </div>
                              <div>
                                {uxText('chronos_mission_type', locale)}:{' '}
                                <span className="kb-text-secondary">
                                  {mission.missionType === 'product_delivery'
                                    ? uxText('chronos_mission_type_product_delivery', locale)
                                    : mission.missionType || '-'}
                                </span>
                              </div>
                              <div>
                                {uxText('chronos_mission_artifacts', locale)}:{' '}
                                <span className="kb-text-secondary">
                                  {mission.artifactCount || 0}
                                  {mission.artifactKinds?.length
                                    ? ` · ${mission.artifactKinds.slice(0, 3).join(', ')}`
                                    : ''}
                                </span>
                              </div>
                              <div>
                                {uxText('chronos_mission_tier', locale)}:{' '}
                                <span className="kb-text-secondary">{mission.tier || '-'}</span>
                              </div>
                              <div>
                                {uxText('chronos_updated', locale)}:{' '}
                                {mission.updatedAt || mission.startedAt || '-'}
                              </div>
                              <div className="truncate">
                                {uxText('chronos_tenant', locale)}:{' '}
                                {mission.tenantSlug || mission.tenantId || '-'}
                              </div>
                            </div>
                            {mission.successCondition ? (
                              <div className="mt-2 text-[11px] leading-6 kb-text-secondary">
                                {mission.successCondition}
                              </div>
                            ) : null}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}

                {consoleSection === 'diagnostics' ? (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="kyberion-glass rounded-xl border kb-border-subtle p-5 md:p-6">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] kb-text-muted">
                            {uxText('chronos_diagnostics_cost', locale)}
                          </div>
                          <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                            {uxText('chronos_diagnostics_cost_title', locale)}
                          </h2>
                        </div>
                        <div className="text-[11px] kb-text-muted">
                          {selectedMissionId ? selectedMissionId : uxText('chronos_today', locale)}
                        </div>
                      </div>
                      {costSummaryError ? (
                        <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                          {costSummaryError}
                        </div>
                      ) : null}
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-4">
                          <div className="text-[11px] kb-text-muted">
                            {uxText('chronos_diagnostics_currency', locale)}
                          </div>
                          <div className="mt-2 text-2xl font-semibold kb-text-primary">
                            {typeof costSummary?.totalUsd === 'number'
                              ? `$${costSummary.totalUsd.toFixed(3)}`
                              : '-'}
                          </div>
                          <div className="mt-1 text-[11px] kb-text-muted">
                            {costSummary?.entryCount || 0}{' '}
                            {uxText('chronos_diagnostics_entries', locale)}
                          </div>
                        </div>
                        <div className="rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-4">
                          <div className="text-[11px] kb-text-muted">
                            {uxText('chronos_diagnostics_tokens', locale)}
                          </div>
                          <div className="mt-2 text-2xl font-semibold kb-text-primary">
                            {typeof costSummary?.totalTokens === 'number'
                              ? costSummary.totalTokens.toLocaleString(chronosSpeechLocale())
                              : '-'}
                          </div>
                          <div className="mt-1 text-[11px] kb-text-muted">
                            {costSummary?.missionCount || 0}{' '}
                            {uxText('chronos_diagnostics_missions', locale)}
                          </div>
                        </div>
                        <div className="rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-4">
                          <div className="text-[11px] kb-text-muted">予算</div>
                          <div className="mt-2 text-2xl font-semibold kb-text-primary">
                            {typeof costSummary?.budgetUsd === 'number'
                              ? `$${costSummary.budgetUsd.toFixed(3)}`
                              : '未設定'}
                          </div>
                          <div className="mt-1 text-[11px] kb-text-muted">
                            {typeof costSummary?.remainingUsd === 'number'
                              ? `remaining $${costSummary.remainingUsd.toFixed(3)}`
                              : uxText('chronos_no_budget_guard', locale)}
                          </div>
                        </div>
                        <div className="rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-4">
                          <div className="text-[11px] kb-text-muted">
                            {uxText('chronos_diagnostics_generation_actual', locale)}
                          </div>
                          <div className="mt-2 text-2xl font-semibold kb-text-primary">
                            {typeof costSummary?.generation?.actualUsd === 'number'
                              ? `$${costSummary.generation.actualUsd.toFixed(3)}`
                              : '-'}
                          </div>
                          <div className="mt-1 text-[11px] kb-text-muted">
                            {costSummary?.generation?.settledJobs || 0}{' '}
                            {uxText('chronos_diagnostics_entries', locale)}
                          </div>
                          {costSummary?.generation?.awaitingActualCost ? (
                            <div className="mt-1 text-[11px] kb-status-warning">
                              {costSummary.generation.awaitingActualCost}{' '}
                              {uxText('chronos_diagnostics_generation_pending', locale)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      {Array.isArray(costSummary?.missionBreakdown) &&
                      costSummary.missionBreakdown.length > 0 ? (
                        <div className="mt-4 space-y-2">
                          {costSummary.missionBreakdown.slice(0, 4).map((item: any) => (
                            <div
                              key={item.missionId}
                              className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] kb-text-muted"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setSelectedMissionId(
                                      item.missionId === 'UNASSIGNED' ? null : item.missionId
                                    )
                                  }
                                  className="font-mono text-[11px] kb-text-accent"
                                >
                                  {item.missionId}
                                </button>
                                <div className="kb-text-primary">${item.usd.toFixed(3)}</div>
                              </div>
                              <div className="mt-1 kb-text-muted">
                                {item.tokens.toLocaleString(chronosSpeechLocale())}{' '}
                                {uxText('chronos_diagnostics_tokens', locale)} · {item.entryCount}{' '}
                                {uxText('chronos_diagnostics_entries', locale)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="kyberion-glass rounded-xl border kb-border-subtle p-5 md:p-6">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] kb-text-muted">
                            {uxText('chronos_connection_check', locale)}
                          </div>
                          <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                            {uxText('chronos_connection_review', locale)}
                          </h2>
                        </div>
                        <input
                          value={connectionsQuery}
                          onChange={(event) => setConnectionsQuery(event.target.value)}
                          placeholder={uxText('chronos_search', locale)}
                          className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
                        />
                      </div>
                      {connectionsError ? (
                        <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                          {connectionsError}
                        </div>
                      ) : null}
                      <div className="mt-4 max-h-[240px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                        {connections
                          .filter((item) => {
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
                          .map((item) => (
                            <button
                              key={item.binding_id}
                              type="button"
                              onClick={() => {
                                setSelectedConnectionId(item.binding_id);
                                setConnectionsError(null);
                              }}
                              className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                                selectedConnectionId === item.binding_id
                                  ? 'kb-border-accent kb-surface-accent'
                                  : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-[11px] kb-text-muted">
                                    {item.service_type || 'service'} · {item.binding_id}
                                  </div>
                                  <div className="mt-1 text-sm font-semibold kb-text-primary">
                                    {item.service_id || item.target}
                                  </div>
                                </div>
                                <div className="text-[11px] kb-text-accent">
                                  {item.reviewAction || 'pending'}
                                </div>
                              </div>
                              <div className="mt-2 grid gap-2 text-[11px] kb-text-muted sm:grid-cols-2">
                                <div>scope {item.scope}</div>
                                <div>target {item.target}</div>
                                <div>policy {Object.keys(item.approval_policy || {}).length}</div>
                                <div>reviewed {item.reviewedAt || '-'}</div>
                              </div>
                            </button>
                          ))}
                      </div>
                      {selectedConnectionId ? (
                        <div className="mt-4 rounded-lg border kb-border-accent kb-surface-accent p-4">
                          {(() => {
                            const selected = connections.find(
                              (item) => item.binding_id === selectedConnectionId
                            );
                            if (!selected)
                              return (
                                <div className="text-[11px] kb-text-muted">
                                  Selected connection not found.
                                </div>
                              );
                            return (
                              <>
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[11px] kb-text-accent">review</div>
                                    <div className="mt-1 text-sm font-semibold kb-text-primary">
                                      {selected.service_id || selected.binding_id}
                                    </div>
                                  </div>
                                  <div className="text-[11px] kb-text-muted">
                                    {selected.reviewAction || 'pending'}
                                  </div>
                                </div>
                                <textarea
                                  value={connectionReviewNote}
                                  onChange={(event) => setConnectionReviewNote(event.target.value)}
                                  placeholder="review note"
                                  className="mt-3 min-h-[80px] w-full rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
                                />
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    disabled={connectionReviewBusyId === selected.binding_id}
                                    onClick={() =>
                                      submitConnectionReview(selected.binding_id, 'approve')
                                    }
                                    className={`rounded-lg border px-3 py-2 text-[11px] transition disabled:opacity-50 ${toneChipClass('approve')}`}
                                  >
                                    approve
                                  </button>
                                  <button
                                    type="button"
                                    disabled={connectionReviewBusyId === selected.binding_id}
                                    onClick={() =>
                                      submitConnectionReview(selected.binding_id, 'modify')
                                    }
                                    className={`rounded-lg border px-3 py-2 text-[11px] transition disabled:opacity-50 ${toneChipClass('info')}`}
                                  >
                                    modify
                                  </button>
                                  <button
                                    type="button"
                                    disabled={connectionReviewBusyId === selected.binding_id}
                                    onClick={() =>
                                      submitConnectionReview(selected.binding_id, 'hold')
                                    }
                                    className={`rounded-lg border px-3 py-2 text-[11px] transition disabled:opacity-50 ${toneChipClass('alert')}`}
                                  >
                                    hold
                                  </button>
                                  <button
                                    type="button"
                                    disabled={connectionReviewBusyId === selected.binding_id}
                                    onClick={() =>
                                      submitConnectionReview(selected.binding_id, 'delete')
                                    }
                                    className={`rounded-lg border px-3 py-2 text-[11px] transition disabled:opacity-50 ${toneChipClass('reject')}`}
                                  >
                                    delete
                                  </button>
                                </div>
                              </>
                            );
                          })()}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </section>
            )}

            {consoleSection === 'missions' && (
              <section className="grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
                {consoleSection === 'missions' ? (
                  <div className="kyberion-glass rounded-xl border kb-border-subtle p-5 md:p-6">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] kb-text-accent">
                          {uxText('chronos_mission_plan_title', locale)}
                        </div>
                        <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                          {uxText('chronos_mission_plan_title', locale)}
                        </h2>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={runPlanPreview}
                          disabled={planPreviewBusy}
                          className="rounded-lg border kb-border-accent kb-surface-accent px-3 py-2 text-[11px] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {planPreviewBusy
                            ? uxText('chronos_previewing', locale)
                            : uxText('chronos_preview', locale)}
                        </button>
                        <button
                          type="button"
                          onClick={approvePlanAndStart}
                          disabled={planApprovalBusy || !planPreview || planPreviewIsStale}
                          className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-3 py-2 text-[11px] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {planApprovalBusy
                            ? uxText('chronos_starting', locale)
                            : uxText('chronos_approve_start', locale)}
                        </button>
                      </div>
                    </div>
                    {planPreview && planPreviewIsStale ? (
                      <div className="mt-3 rounded-xl border kb-status-warning-border kb-status-warning-surface px-4 py-3 text-[11px] kb-status-warning">
                        {uxText('chronos_preview_stale', locale)}
                      </div>
                    ) : null}
                    <textarea
                      value={planRequestText}
                      onChange={(event) => setPlanRequestText(event.target.value)}
                      placeholder="例: 来週までに顧客向け提案資料を作って、承認前にレビューしたい"
                      className="mt-4 min-h-[120px] w-full rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
                    />
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <label className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-3 text-[11px] kb-text-muted">
                        {uxText('chronos_mission_type_field', locale)}
                        <input
                          value={planMissionType}
                          onChange={(event) => setPlanMissionType(event.target.value)}
                          className="mt-2 w-full rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] tracking-normal kb-text-primary outline-none focus:kb-border-accent"
                        />
                      </label>
                      <label className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-3 text-[11px] kb-text-muted">
                        {uxText('chronos_persona_field', locale)}
                        <input
                          value={planPersona}
                          onChange={(event) => setPlanPersona(event.target.value)}
                          className="mt-2 w-full rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] tracking-normal kb-text-primary outline-none focus:kb-border-accent"
                        />
                      </label>
                      <label className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-3 text-[11px] kb-text-muted">
                        {uxText('chronos_data_level_field', locale)}
                        <select
                          value={planTier}
                          onChange={(event) =>
                            setPlanTier(
                              event.target.value as 'personal' | 'confidential' | 'public'
                            )
                          }
                          className="mt-2 w-full rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] tracking-normal kb-text-primary outline-none focus:kb-border-accent"
                        >
                          <option value="personal">personal</option>
                          <option value="confidential">confidential</option>
                          <option value="public">public</option>
                        </select>
                      </label>
                    </div>
                    {planPreviewError ? (
                      <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                        {planPreviewError}
                      </div>
                    ) : null}
                    {planApprovalMessage ? (
                      <div className="mt-3 rounded-xl border kb-status-positive-border kb-status-positive-surface px-4 py-3 text-[11px] kb-status-positive">
                        {planApprovalMessage}
                      </div>
                    ) : null}
                    {planPreview ? (
                      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr,0.85fr]">
                        <div className="rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-4">
                          <div className="text-[11px] kb-text-muted">goal</div>
                          <div className="mt-2 text-sm font-semibold kb-text-primary">
                            {planPreview.goal?.summary}
                          </div>
                          <div className="mt-2 text-[11px] leading-6 kb-text-muted">
                            {planPreview.goal?.successCondition}
                          </div>
                          <div className="mt-4 grid grid-cols-2 gap-3 text-[11px] kb-text-muted">
                            <div>
                              delivery mode{' '}
                              <span className="font-mono kb-text-primary">
                                {planPreview.delivery?.mode}
                              </span>
                            </div>
                            <div>
                              clarification{' '}
                              <span className="font-mono kb-text-primary">
                                {planPreview.delivery?.clarificationNeeded ? 'needed' : 'clear'}
                              </span>
                            </div>
                            <div>
                              execution{' '}
                              <span className="font-mono kb-text-primary">
                                {planPreview.execution?.shape}
                              </span>
                            </div>
                            <div>
                              confidence{' '}
                              <span className="font-mono kb-text-primary">
                                {Math.round((Number(planPreview.confidence) || 0) * 100)}%
                              </span>
                            </div>
                          </div>
                          {Array.isArray(planPreview.execution?.clarificationQuestions) &&
                          planPreview.execution.clarificationQuestions.length > 0 ? (
                            <div className="mt-4">
                              <KbInterventionPanel
                                reason="Clarification is required before approval. 質問をクリックすると依頼文に回答欄が追加されます。"
                                isBlocking
                                options={planPreview.execution.clarificationQuestions.map(
                                  (question: any) => ({
                                    label: question.question,
                                    variant: 'neutral' as const,
                                    value: question.id,
                                  })
                                )}
                                onSelectOption={(option) => {
                                  setPlanRequestText(
                                    (current) =>
                                      `${current.trimEnd()}\n\n【確認事項への回答】${option.label}\n→ `
                                  );
                                  setPlanApprovalMessage(
                                    '確認事項を依頼文に追記しました。回答を書いてから再プレビューしてください。'
                                  );
                                }}
                              />
                            </div>
                          ) : null}
                        </div>
                        <div className="rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-4">
                          <div className="text-[11px] kb-text-muted">team + workflow</div>
                          <div className="mt-2 text-[11px] kb-text-muted">
                            {planPreview.team?.assignments?.length || 0} assignments ·{' '}
                            {planPreview.team?.team_governance?.composition?.required_roles
                              ?.length || 0}{' '}
                            required roles
                          </div>
                          <div className="mt-3 space-y-2">
                            {(planPreview.team?.assignments || [])
                              .slice(0, 5)
                              .map((assignment: any) => (
                                <div
                                  key={`${assignment.team_role}-${assignment.agent_id || 'unfilled'}`}
                                  className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="text-[11px] kb-text-muted">
                                      {assignment.team_role}
                                    </div>
                                    <div className="text-[11px] kb-text-muted">
                                      {assignment.status}
                                    </div>
                                  </div>
                                  <div className="mt-1 font-mono text-[11px] kb-text-secondary">
                                    {assignment.agent_id || 'unfilled'}
                                  </div>
                                </div>
                              ))}
                          </div>
                          <div className="mt-4 text-[11px] kb-text-muted">workflow steps</div>
                          <div className="mt-2 space-y-2">
                            {(planPreview.workflow || []).slice(0, 5).map((step: any) => (
                              <div
                                key={step.id}
                                className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2"
                              >
                                <div className="text-[11px] kb-text-primary">{step.label}</div>
                                <div className="mt-1 text-[11px] leading-5 kb-text-muted">
                                  {step.description}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="kyberion-glass rounded-xl border kb-border-subtle p-5 md:p-6">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] kb-text-muted">
                        {uxText('chronos_deliverables', locale)}
                      </div>
                      <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                        {uxText('chronos_deliverables_preview_title', locale)}
                      </h2>
                    </div>
                    <input
                      value={deliverablesQuery}
                      onChange={(event) => setDeliverablesQuery(event.target.value)}
                      placeholder={uxText('chronos_search', locale)}
                      className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
                    />
                  </div>
                  {deliverablesError ? (
                    <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                      {deliverablesError}
                    </div>
                  ) : null}
                  {cleanedDeliverableCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => setShowCleanedDeliverables((current) => !current)}
                      className={`mt-3 rounded-xl border px-3 py-2 text-[11px] transition ${toneChipClass('neutral')}`}
                    >
                      {uxMessage(
                        showCleanedDeliverables
                          ? 'chronos_dl_hide_cleaned'
                          : 'chronos_dl_show_cleaned',
                        { count: cleanedDeliverableCount },
                        '{count} cleaned-up record(s)',
                        locale
                      )}
                    </button>
                  ) : null}
                  <div className="mt-4 max-h-[540px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                    {visibleDeliverables.length === 0 ? (
                      <div className="rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] kb-text-muted">
                        {deliverables.length === 0
                          ? uxText('chronos_deliverables_empty', locale)
                          : uxText('chronos_dl_none_live', locale)}
                      </div>
                    ) : (
                      visibleDeliverables.map((item) => (
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
                  {selectedDeliverableId ? (
                    <div className="mt-4 rounded-lg border kb-border-accent kb-surface-accent p-4">
                      {(() => {
                        const selected = deliverables.find(
                          (item) => item.artifactId === selectedDeliverableId
                        );
                        if (!selected) {
                          return (
                            <div className="text-[11px] kb-text-muted">
                              Selected deliverable not found.
                            </div>
                          );
                        }
                        return (
                          <>
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-[11px] kb-text-accent">
                                  {uxText('chronos_preview_review', locale)}
                                </div>
                                <div className="mt-1 text-sm font-semibold kb-text-primary">
                                  {selected.artifactId}
                                </div>
                              </div>
                              <div className="text-[11px] kb-text-muted">
                                {selected.reviewVerdict
                                  ? `${uxText('chronos_updated', locale)}: ${selected.reviewVerdict}`
                                  : uxText('chronos_not_reviewed', locale)}
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] leading-6 kb-text-secondary">
                              {selected.previewText || selected.kind}
                            </div>
                            <textarea
                              value={deliverableReviewComment}
                              onChange={(event) => setDeliverableReviewComment(event.target.value)}
                              placeholder="review comment"
                              className="mt-3 min-h-[88px] w-full rounded-lg border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
                            />
                            {deliverableReviewError ? (
                              <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                                {deliverableReviewError}
                              </div>
                            ) : null}
                            {deliverableAskWhyVerdict ? (
                              <div className="mt-3 rounded-xl border kb-status-warning-border kb-status-warning-surface px-4 py-3">
                                <div className="text-[11px] kb-status-warning">
                                  どこが期待と違いましたか？（1問だけ・スキップ可）
                                </div>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {(
                                    [
                                      ['incorrect_content', '内容が誤り'],
                                      ['wrong_direction', '方向が違う'],
                                      ['quality', '品質不足'],
                                      ['scope', 'スコープ過不足'],
                                      ['other', 'その他'],
                                    ] as const
                                  ).map(([category, label]) => (
                                    <button
                                      key={category}
                                      type="button"
                                      disabled={deliverableReviewBusy}
                                      onClick={() =>
                                        submitDeliverableReview(deliverableAskWhyVerdict, {
                                          reasonCategory: category,
                                        })
                                      }
                                      className={`rounded-lg border px-3 py-1.5 text-[11px] transition disabled:opacity-50 ${toneChipClass('alert')}`}
                                    >
                                      {label}
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    disabled={deliverableReviewBusy}
                                    onClick={() =>
                                      submitDeliverableReview(deliverableAskWhyVerdict, {
                                        skipAskWhy: true,
                                      })
                                    }
                                    className={`rounded-lg border px-3 py-1.5 text-[11px] transition disabled:opacity-50 ${toneChipClass('neutral')}`}
                                  >
                                    スキップ
                                  </button>
                                </div>
                              </div>
                            ) : null}
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={deliverableReviewBusy}
                                onClick={() => submitDeliverableReview('accept')}
                                className={`rounded-lg border px-3 py-2 text-[11px] transition disabled:opacity-50 ${toneChipClass('approve')}`}
                              >
                                {uxText('chronos_approve', locale)}
                              </button>
                              <button
                                type="button"
                                disabled={deliverableReviewBusy}
                                onClick={() => submitDeliverableReview('request-changes')}
                                className={`rounded-lg border px-3 py-2 text-[11px] transition disabled:opacity-50 ${toneChipClass('info')}`}
                              >
                                {uxText('chronos_request_changes', locale)}
                              </button>
                              <button
                                type="button"
                                disabled={deliverableReviewBusy}
                                onClick={() => submitDeliverableReview('reject')}
                                className={`rounded-lg border px-3 py-2 text-[11px] transition disabled:opacity-50 ${toneChipClass('reject')}`}
                              >
                                {uxText('chronos_reject', locale)}
                              </button>
                            </div>
                            <div className="mt-3 text-[11px] kb-text-muted">
                              version {selected.reviewVersion || 1}
                              {selected.reviewCurrentArtifactId &&
                              selected.reviewCurrentArtifactId !== selected.artifactId
                                ? ` · current ${selected.reviewCurrentArtifactId}`
                                : ''}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
              </section>
            )}

            {consoleSection === 'missions' ? (
              <section className="kyberion-glass rounded-xl border kb-border-subtle p-5 md:p-6">
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
                  onOpenWorkspace={(target) => openConsoleSection(target)}
                />
              </section>
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
        </div>
      </ChronosUiProviders>
    </Suspense>
  );
}
