'use client';

import { Suspense, type CSSProperties } from 'react';
import { ChronosMirrorLegacySections } from './ChronosMirrorLegacySections';

type ViewModel = Record<string, any>;

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
    tenantLabel,
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
    themeMode,
    webDesignSystem,
    handleReady,
    handleA2UIMessage,
    consoleSection,
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
    homeCopy,
    homePrimaryAction,
    homeCounters,
    isLightTheme,
    shellTextClass,
    shellMutedClass,
    shellSubtleClass,
    shellTitleClass,
    toneChipClass,
    Shield,
    Building2,
    Cpu,
    Palette,
    KbArtifactTile,
    KbInterventionPanel,
    SovereignChat,
    AgentPanel,
    FirstRunBanner,
    IdentityBadge,
    MissionIntelligence,
    MissionJourneySummary,
    ChronosOffice,
    CloudflareOsPanel,
    ApprovalsWorkspace,
    DeliverablesWorkspace,
    KnowledgeWorkspace,
    ChronosTenantScope,
    chronosSpeechLocale,
    nextChronosLocale,
    setChronosLocalePreference,
    uxMessage,
    uxText,
    nextChronosThemeMode,
    TenantDesignBridge,
    CONSOLE_SECTIONS,
  } = model;
  return (
    <Suspense fallback={null}>
      <TenantDesignBridge
        onResolve={(cssVars, label) => {
          setTenantCssVars(cssVars);
          setTenantLabel(label);
        }}
      />
      <main
        className={`min-h-screen w-screen overflow-x-hidden bg-[var(--kb-bg-main)] ${shellTextClass}`}
        data-theme={themeMode}
        style={{ ...(webDesignSystem.css_vars as CSSProperties), ...tenantCssVars }}
      >
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className="absolute left-[-8%] top-[-6%] h-[32rem] w-[32rem] rounded-full kb-surface-accent blur-[160px]" />
          <div className="absolute top-[18%] right-[12%] h-[20rem] w-[20rem] rounded-full kb-surface-accent blur-[150px]" />
          <div className="absolute bottom-[-12%] left-[32%] h-[26rem] w-[26rem] rounded-full kb-surface-sunken blur-[160px]" />
        </div>
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:88px_88px] opacity-[0.06]" />
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(180deg,rgba(255,248,225,0.05)_0%,transparent_18%,transparent_82%,rgba(148,163,184,0.04)_100%)]" />

        <div className="relative z-10 flex min-h-screen flex-col gap-6 p-4 md:p-6">
          <header className="px-1 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border kb-border-accent kb-surface-accent">
                  <Shield className="h-5 w-5 kb-text-accent" />
                </div>
                <div>
                  <div
                    className={`text-[10px] uppercase tracking-[0.3em] font-bold ${shellMutedClass}`}
                  >
                    Chronos Mirror
                  </div>
                  <h1 className={`text-lg font-bold tracking-tight ${shellTitleClass}`}>
                    {uxText('chronos_home_title', locale)}
                  </h1>
                  <p className={`mt-0.5 text-[11px] ${shellMutedClass}`}>
                    {uxText('chronos_surface_role_tagline', locale)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openConsoleSection('operations')}
                  className={`ml-2 rounded-full border px-3 py-1 text-[11px] transition ${consoleSection === 'operations' ? 'kb-border-accent kb-surface-accent kb-text-accent' : isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised'}`}
                >
                  {uxText('chronos_nav_operations', locale)}
                </button>
                <button
                  type="button"
                  onClick={() => openConsoleSection('organization')}
                  className={`ml-2 flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] transition ${consoleSection === 'organization' ? 'kb-border-accent kb-surface-accent kb-text-accent' : isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised'}`}
                >
                  <Building2 size={12} />
                  {uxText('chronos_nav_organization', locale)}
                </button>
              </div>
              {tenantLabel ? (
                <div className="rounded-full border kb-border-accent kb-surface-accent px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] kb-text-accent">
                  {tenantLabel}
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setThemeModePreference(nextChronosThemeMode)}
                  aria-label={`Chronos theme: ${themeModePreference}`}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 ${isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised hover:kb-text-accent'}`}
                >
                  <Palette size={12} />
                  <span>
                    {themeModePreference === 'system'
                      ? uxText('chronos_theme_auto', locale)
                      : themeModePreference === 'light'
                        ? uxText('chronos_theme_light', locale)
                        : uxText('chronos_theme_dark', locale)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setChronosLocalePreference(nextChronosLocale(locale))}
                  aria-label={
                    locale === 'ja' ? 'Switch language to English' : '言語を日本語に切り替え'
                  }
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 ${isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised hover:kb-text-accent'}`}
                >
                  <span>{locale === 'ja' ? 'JA' : 'EN'}</span>
                </button>
                <IdentityBadge />
                <button
                  type="button"
                  onClick={() => setAgentPanelOpen(true)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 ${isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised hover:kb-text-accent'}`}
                >
                  <Cpu size={12} />
                  <span>{uxText('chronos_agent_runtimes', locale)}</span>
                </button>
              </div>
            </div>
          </header>

          <ChronosTenantScope />

          <nav
            aria-label="Chronos sections"
            className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-2xl border kb-border-subtle kb-surface-sunken p-2"
          >
            <div className="mr-2 hidden px-2 text-[10px] font-bold uppercase tracking-[0.2em] kb-text-muted lg:block">
              {uxText('chronos_workspace', locale)}
            </div>
            {CONSOLE_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => openConsoleSection(section.id)}
                aria-current={consoleSection === section.id ? 'page' : undefined}
                className={`rounded-xl border px-3 py-2 text-left transition ${
                  consoleSection === section.id
                    ? 'kb-border-accent kb-surface-accent kb-text-accent'
                    : 'kb-border-subtle kb-surface-raised kb-text-secondary hover:kb-border-accent'
                }`}
              >
                <div className="text-[10px] font-bold uppercase tracking-[0.16em]">
                  {uxText(section.labelKey, locale)}
                </div>
                <div className="mt-0.5 hidden text-[9px] kb-text-muted sm:block">
                  {uxText(section.detailKey, locale)}
                </div>
              </button>
            ))}
          </nav>

          {consoleSection === 'home' ? (
            <>
              {/* The command band: role, current state, the one action to take,
                  and counters that double as navigation. This is deliberately the
                  first thing on the home page — detail views should start with
                  their own content. */}
              <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="max-w-3xl">
                    <div
                      className={`flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[0.28em] ${shellMutedClass}`}
                    >
                      <span>{uxText('chronos_cb_do_this_next', locale)}</span>
                    </div>
                    <h2
                      className={`mt-3 text-xl font-semibold leading-snug tracking-tight ${shellTitleClass} md:text-2xl`}
                    >
                      {homeCopy.statusMessage}
                    </h2>
                    <p className={`mt-2 text-sm leading-6 ${shellSubtleClass}`}>
                      {uxText('chronos_cb_instruction', locale)}
                    </p>
                  </div>
                  <div
                    className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] ${toneChipClass(
                      operatorHomeSummary?.status === 'blocked'
                        ? 'reject'
                        : operatorHomeSummary?.status === 'attention'
                          ? 'alert'
                          : operatorHomeSummary
                            ? 'approve'
                            : 'neutral'
                    )}`}
                  >
                    {homeCopy.statusLabel}
                  </div>
                </div>

                {operatorHomeError ? (
                  <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                    {operatorHomeError}
                  </div>
                ) : null}

                {homePrimaryAction ? (
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border kb-border-accent kb-surface-accent px-4 py-4">
                    <div className="min-w-0">
                      <div
                        className={`text-[10px] font-bold uppercase tracking-[0.22em] ${shellMutedClass}`}
                      >
                        {uxText('chronos_cb_do_this_next', locale)}
                      </div>
                      <div className={`mt-1 text-base font-semibold ${shellTitleClass}`}>
                        {homePrimaryAction.title}
                      </div>
                      <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                        {homePrimaryAction.reason}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        handleScenarioOpen(homePrimaryAction.targetId, homePrimaryAction.surface)
                      }
                      className={`rounded-xl border px-5 py-3 text-[11px] font-bold uppercase tracking-[0.2em] transition ${toneChipClass('info')}`}
                    >
                      {uxText('chronos_cb_open', locale)} →
                    </button>
                  </div>
                ) : null}

                {homeCounters.length > 0 ? (
                  <>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {homeCounters.map((counter) => (
                        <button
                          key={counter.key}
                          type="button"
                          onClick={() =>
                            handleScenarioOpen(counter.targetId, 'mission-intelligence')
                          }
                          className={`rounded-2xl border px-4 py-3 text-left transition ${toneChipClass(
                            counter.value > 0 ? counter.tone : 'neutral'
                          )}`}
                        >
                          <div className="text-2xl font-semibold leading-none">{counter.value}</div>
                          <div className="mt-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                            {counter.label}
                          </div>
                        </button>
                      ))}
                    </div>
                    <div
                      className={`mt-3 text-[10px] uppercase tracking-[0.16em] ${shellMutedClass}`}
                    >
                      {uxText('chronos_cb_counts_hint', locale)}
                    </div>
                  </>
                ) : null}

                {operatorHomeSummary?.activeMissions?.length ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {operatorHomeSummary.activeMissions.slice(0, 4).map((mission) => (
                      <button
                        key={mission.missionId}
                        type="button"
                        onClick={() => setSelectedMissionId(mission.missionId)}
                        className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.16em] transition ${toneChipClass('neutral')}`}
                      >
                        {mission.missionId}
                      </button>
                    ))}
                  </div>
                ) : null}
                {operatorHomeSummary?.plannedMissions?.length ? (
                  <div className="mt-4 rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] kb-text-accent">
                      {uxText('chronos_home_planned_title', locale)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {operatorHomeSummary.plannedMissions.slice(0, 4).map((mission: any) => (
                        <button
                          key={mission.missionId}
                          type="button"
                          onClick={() =>
                            handleOperatorViewOpen('mission-control-plane', mission.missionId)
                          }
                          className="rounded-full border kb-border-subtle px-3 py-1 text-[10px] font-mono kb-text-secondary hover:kb-border-accent hover:kb-text-accent"
                        >
                          {mission.missionId} · {mission.projectId || 'project pending'}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>
            </>
          ) : null}

          {consoleSection === 'home' ? (
            <>
              <ChronosOffice
                compact
                tenant={tenant}
                onOpenOperations={() => openConsoleSection('operations')}
              />
              <CloudflareOsPanel missionId={selectedMissionId} />
              <MissionJourneySummary
                summary={operatorHomeSummary}
                onOpenMissions={() => openConsoleSection('missions')}
                onOpenOperations={() => openConsoleSection('operations')}
              />
              <FirstRunBanner />
            </>
          ) : null}

          {(consoleSection === 'missions' || consoleSection === 'diagnostics') && (
            <section className={`grid gap-4 ${'xl:grid-cols-1'}`}>
              {consoleSection === 'missions' ? (
                <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
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
                        className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
                      />
                      <select
                        value={missionHistoryStatus}
                        onChange={(event) => setMissionHistoryStatus(event.target.value)}
                        className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none focus:kb-border-accent"
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
                        className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none focus:kb-border-accent"
                      >
                        <option value="">{uxText('chronos_all_tiers', locale)}</option>
                        <option value="public">{uxText('chronos_tier_public', locale)}</option>
                        <option value="confidential">
                          {uxText('chronos_tier_confidential', locale)}
                        </option>
                        <option value="personal">{uxText('chronos_tier_personal', locale)}</option>
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
                      <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] kb-text-muted">
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
                          className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                            selectedMissionId === mission.missionId
                              ? 'kb-border-accent kb-surface-accent'
                              : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                {mission.missionId}
                              </div>
                              <div className="mt-1 text-sm font-semibold kb-text-primary">
                                {mission.goalSummary ||
                                mission.intentText ||
                                mission.missionType === 'product_delivery'
                                  ? uxText('chronos_mission_type_product_delivery', locale)
                                  : mission.missionType || uxText('chronos_mission', locale)}
                              </div>
                            </div>
                            <div className="text-right text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                              {mission.status === 'completed'
                                ? uxText('chronos_status_completed', locale)
                                : mission.status === 'active'
                                  ? uxText('chronos_status_active', locale)
                                  : mission.status === 'paused'
                                    ? uxText('chronos_status_paused', locale)
                                    : mission.status === 'failed'
                                      ? uxText('chronos_status_failed', locale)
                                      : mission.status}
                            </div>
                          </div>
                          <div className="mt-2 grid gap-2 text-[10px] kb-text-muted sm:grid-cols-2">
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
                  <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
                          {uxText('chronos_diagnostics_cost', locale)}
                        </div>
                        <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                          {uxText('chronos_diagnostics_cost_title', locale)}
                        </h2>
                      </div>
                      <div className="text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                        {selectedMissionId ? selectedMissionId : uxText('chronos_today', locale)}
                      </div>
                    </div>
                    {costSummaryError ? (
                      <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                        {costSummaryError}
                      </div>
                    ) : null}
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          {uxText('chronos_diagnostics_currency', locale)}
                        </div>
                        <div className="mt-2 text-2xl font-semibold kb-text-primary">
                          {typeof costSummary?.totalUsd === 'number'
                            ? `$${costSummary.totalUsd.toFixed(3)}`
                            : '-'}
                        </div>
                        <div className="mt-1 text-[10px] kb-text-muted">
                          {costSummary?.entryCount || 0}{' '}
                          {uxText('chronos_diagnostics_entries', locale)}
                        </div>
                      </div>
                      <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          {uxText('chronos_diagnostics_tokens', locale)}
                        </div>
                        <div className="mt-2 text-2xl font-semibold kb-text-primary">
                          {typeof costSummary?.totalTokens === 'number'
                            ? costSummary.totalTokens.toLocaleString(chronosSpeechLocale())
                            : '-'}
                        </div>
                        <div className="mt-1 text-[10px] kb-text-muted">
                          {costSummary?.missionCount || 0}{' '}
                          {uxText('chronos_diagnostics_missions', locale)}
                        </div>
                      </div>
                      <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          予算
                        </div>
                        <div className="mt-2 text-2xl font-semibold kb-text-primary">
                          {typeof costSummary?.budgetUsd === 'number'
                            ? `$${costSummary.budgetUsd.toFixed(3)}`
                            : '未設定'}
                        </div>
                        <div className="mt-1 text-[10px] kb-text-muted">
                          {typeof costSummary?.remainingUsd === 'number'
                            ? `remaining $${costSummary.remainingUsd.toFixed(3)}`
                            : uxText('chronos_no_budget_guard', locale)}
                        </div>
                      </div>
                      <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          {uxText('chronos_diagnostics_generation_actual', locale)}
                        </div>
                        <div className="mt-2 text-2xl font-semibold kb-text-primary">
                          {typeof costSummary?.generation?.actualUsd === 'number'
                            ? `$${costSummary.generation.actualUsd.toFixed(3)}`
                            : '-'}
                        </div>
                        <div className="mt-1 text-[10px] kb-text-muted">
                          {costSummary?.generation?.settledJobs || 0}{' '}
                          {uxText('chronos_diagnostics_entries', locale)}
                        </div>
                        {costSummary?.generation?.awaitingActualCost ? (
                          <div className="mt-1 text-[10px] kb-status-warning">
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
                            className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] kb-text-muted"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <button
                                type="button"
                                onClick={() =>
                                  setSelectedMissionId(
                                    item.missionId === 'UNASSIGNED' ? null : item.missionId
                                  )
                                }
                                className="font-mono text-[10px] uppercase tracking-[0.16em] kb-text-accent"
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

                  <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
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
                        className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
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
                            className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                              selectedConnectionId === item.binding_id
                                ? 'kb-border-accent kb-surface-accent'
                                : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                  {item.service_type || 'service'} · {item.binding_id}
                                </div>
                                <div className="mt-1 text-sm font-semibold kb-text-primary">
                                  {item.service_id || item.target}
                                </div>
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                                {item.reviewAction || 'pending'}
                              </div>
                            </div>
                            <div className="mt-2 grid gap-2 text-[10px] kb-text-muted sm:grid-cols-2">
                              <div>scope {item.scope}</div>
                              <div>target {item.target}</div>
                              <div>policy {Object.keys(item.approval_policy || {}).length}</div>
                              <div>reviewed {item.reviewedAt || '-'}</div>
                            </div>
                          </button>
                        ))}
                    </div>
                    {selectedConnectionId ? (
                      <div className="mt-4 rounded-2xl border kb-border-accent kb-surface-accent p-4">
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
                                  <div className="text-[10px] uppercase tracking-[0.22em] kb-text-accent">
                                    review
                                  </div>
                                  <div className="mt-1 text-sm font-semibold kb-text-primary">
                                    {selected.service_id || selected.binding_id}
                                  </div>
                                </div>
                                <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                  {selected.reviewAction || 'pending'}
                                </div>
                              </div>
                              <textarea
                                value={connectionReviewNote}
                                onChange={(event) => setConnectionReviewNote(event.target.value)}
                                placeholder="review note"
                                className="mt-3 min-h-[80px] w-full rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
                              />
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  disabled={connectionReviewBusyId === selected.binding_id}
                                  onClick={() =>
                                    submitConnectionReview(selected.binding_id, 'approve')
                                  }
                                  className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('approve')}`}
                                >
                                  approve
                                </button>
                                <button
                                  type="button"
                                  disabled={connectionReviewBusyId === selected.binding_id}
                                  onClick={() =>
                                    submitConnectionReview(selected.binding_id, 'modify')
                                  }
                                  className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('info')}`}
                                >
                                  modify
                                </button>
                                <button
                                  type="button"
                                  disabled={connectionReviewBusyId === selected.binding_id}
                                  onClick={() =>
                                    submitConnectionReview(selected.binding_id, 'hold')
                                  }
                                  className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('alert')}`}
                                >
                                  hold
                                </button>
                                <button
                                  type="button"
                                  disabled={connectionReviewBusyId === selected.binding_id}
                                  onClick={() =>
                                    submitConnectionReview(selected.binding_id, 'delete')
                                  }
                                  className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('reject')}`}
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
                <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
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
                        className="rounded-lg border kb-border-accent kb-surface-accent px-3 py-2 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {planPreviewBusy
                          ? uxText('chronos_previewing', locale)
                          : uxText('chronos_preview', locale)}
                      </button>
                      <button
                        type="button"
                        onClick={approvePlanAndStart}
                        disabled={planApprovalBusy || !planPreview || planPreviewIsStale}
                        className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-3 py-2 text-[10px] uppercase tracking-[0.18em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-50"
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
                    className="mt-4 min-h-[120px] w-full rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
                  />
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    <label className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                      {uxText('chronos_mission_type_field', locale)}
                      <input
                        value={planMissionType}
                        onChange={(event) => setPlanMissionType(event.target.value)}
                        className="mt-2 w-full rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] tracking-normal kb-text-primary outline-none focus:kb-border-accent"
                      />
                    </label>
                    <label className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                      {uxText('chronos_persona_field', locale)}
                      <input
                        value={planPersona}
                        onChange={(event) => setPlanPersona(event.target.value)}
                        className="mt-2 w-full rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] tracking-normal kb-text-primary outline-none focus:kb-border-accent"
                      />
                    </label>
                    <label className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                      {uxText('chronos_data_level_field', locale)}
                      <select
                        value={planTier}
                        onChange={(event) =>
                          setPlanTier(event.target.value as 'personal' | 'confidential' | 'public')
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
                      <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          goal
                        </div>
                        <div className="mt-2 text-sm font-semibold kb-text-primary">
                          {planPreview.goal?.summary}
                        </div>
                        <div className="mt-2 text-[11px] leading-6 kb-text-muted">
                          {planPreview.goal?.successCondition}
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3 text-[10px] kb-text-muted">
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
                      <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          team + workflow
                        </div>
                        <div className="mt-2 text-[11px] kb-text-muted">
                          {planPreview.team?.assignments?.length || 0} assignments ·{' '}
                          {planPreview.team?.team_governance?.composition?.required_roles?.length ||
                            0}{' '}
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
                                  <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                                    {assignment.team_role}
                                  </div>
                                  <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                                    {assignment.status}
                                  </div>
                                </div>
                                <div className="mt-1 font-mono text-[10px] kb-text-secondary">
                                  {assignment.agent_id || 'unfilled'}
                                </div>
                              </div>
                            ))}
                        </div>
                        <div className="mt-4 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                          workflow steps
                        </div>
                        <div className="mt-2 space-y-2">
                          {(planPreview.workflow || []).slice(0, 5).map((step: any) => (
                            <div
                              key={step.id}
                              className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2"
                            >
                              <div className="text-[10px] kb-text-primary">{step.label}</div>
                              <div className="mt-1 text-[9px] leading-5 kb-text-muted">
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

              <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
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
                    className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
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
                    className={`mt-3 rounded-xl border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition ${toneChipClass('neutral')}`}
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
                    <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] kb-text-muted">
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
                  <div className="mt-4 rounded-2xl border kb-border-accent kb-surface-accent p-4">
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
                              <div className="text-[10px] uppercase tracking-[0.22em] kb-text-accent">
                                {uxText('chronos_preview_review', locale)}
                              </div>
                              <div className="mt-1 text-sm font-semibold kb-text-primary">
                                {selected.artifactId}
                              </div>
                            </div>
                            <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
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
                            className="mt-3 min-h-[88px] w-full rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
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
                              className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('approve')}`}
                            >
                              {uxText('chronos_approve', locale)}
                            </button>
                            <button
                              type="button"
                              disabled={deliverableReviewBusy}
                              onClick={() => submitDeliverableReview('request-changes')}
                              className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('info')}`}
                            >
                              {uxText('chronos_request_changes', locale)}
                            </button>
                            <button
                              type="button"
                              disabled={deliverableReviewBusy}
                              onClick={() => submitDeliverableReview('reject')}
                              className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('reject')}`}
                            >
                              {uxText('chronos_reject', locale)}
                            </button>
                          </div>
                          <div className="mt-3 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
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
            <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
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
        </div>
      </main>
    </Suspense>
  );
}
