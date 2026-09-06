'use client';

type ViewModel = Record<string, any>;

export function ChronosMirrorLegacySections({ model }: { model: ViewModel }) {
  const {
    locale,
    tenant,
    organizationId,
    projectId,
    quickActionGroups,
    statusCards,
    surface,
    focusedOperatorView,
    missionIntelligenceFocus,
    missionIntelligenceFocusedMissionId,
    focusedOperatorMissionId,
    expandedSections,
    mainSurfaceRef,
    webDesignSystem,
    toggleSection,
    handleQuickAction,
    handleSectionJump,
    a2uiActionNotice,
    consoleSection,
    surfaceOrigin,
    openConsoleSection,
    handleA2UIComponentAction,
    handleOperatorViewOpen,
    handleScenarioOpen,
    activeSurfaceTitle,
    activeScenario,
    webTheme,
    webLayout,
    legacyWorkspaceEnabled,
    shellMutedClass,
    shellSubtleClass,
    shellTitleClass,
    toneChipClass,
    PanelsTopLeft,
    ChevronDown,
    ChevronRight,
    LayoutGrid,
    Palette,
    Type,
    Ruler,
    AgentOpsBoards,
    A2UIRenderer,
    FocusedOperatorView,
    MissionIntelligence,
    WorkItemsWorkspace,
    SurfaceControlWorkspace,
    OrganizationOperatingModel,
    HeadlessA2UIWorkspace,
    DiagnosticsAttentionSummary,
    MISSION_CYCLE,
    OPERATOR_SCENARIO_PRESETS,
    OPERATOR_VIEW_LINKS,
    SURFACE_ROLES,
    uxText,
  } = model;
  return (
    <>
      {legacyWorkspaceEnabled &&
      consoleSection !== 'deliverables' &&
      consoleSection !== 'approvals' &&
      consoleSection !== 'knowledge' &&
      consoleSection !== 'work-items' &&
      consoleSection !== 'surface-control' &&
      consoleSection !== 'organization' ? (
        <div
          className={`grid flex-1 gap-6 min-h-0 ${
            consoleSection === 'diagnostics' ? 'xl:grid-cols-[280px,1fr]' : 'xl:grid-cols-1'
          }`}
        >
          {consoleSection === 'diagnostics' ? (
            <aside className="min-h-0 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto xl:pr-2 chronos-scroll">
              <div className="flex flex-col gap-6">
                {/* The single primary entry point. Everything else in this
                    sidebar is a drawer below it. */}
                <section className="grid gap-3 xl:grid-cols-[1.35fr,0.85fr]">
                  <div className="kyberion-glass rounded-[24px] border kb-border-accent bg-[linear-gradient(180deg,rgba(247,240,223,0.055),rgba(255,255,255,0.02))] p-4">
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-[0.28em] kb-text-accent">
                          {uxText('chronos_nav_start_here', locale)}
                        </div>
                        <div className="mt-1 text-sm kb-text-secondary">
                          {uxText('chronos_nav_start_here_hint', locale)}
                        </div>
                      </div>
                      <div className="text-[10px] uppercase tracking-[0.22em] kb-text-accent">
                        1-7
                      </div>
                    </div>
                    <div className="mt-4 grid gap-2">
                      {OPERATOR_SCENARIO_PRESETS.map((scenario, index) => {
                        const active =
                          (scenario.surface === 'mission-intelligence' &&
                            missionIntelligenceFocus === scenario.targetId) ||
                          (scenario.surface === 'focused-operator' &&
                            focusedOperatorView === scenario.targetId);
                        return (
                          <button
                            key={scenario.label}
                            type="button"
                            onClick={() => handleScenarioOpen(scenario.targetId, scenario.surface)}
                            className={`rounded-2xl border px-3 py-3 text-left transition ${
                              active
                                ? 'kb-border-accent kb-surface-accent'
                                : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                            }`}
                          >
                            {/* Stacked, not side-by-side: this list lives in a
                                280px column, where a right-aligned action label
                                collided with the scenario name. */}
                            <div className="flex items-center gap-2">
                              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border kb-border-subtle kb-surface-sunken text-[9px] uppercase tracking-[0.16em] kb-text-secondary">
                                {index + 1}
                              </div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] kb-text-secondary">
                                {scenario.label}
                              </div>
                            </div>
                            <div className="mt-1.5 text-[11px] leading-5 kb-text-secondary">
                              {scenario.detail}
                            </div>
                            <div className="mt-2 text-[10px] uppercase tracking-[0.16em] kb-text-accent">
                              {scenario.actionLabel} →
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-4 grid gap-2 text-[9px] uppercase tracking-[0.18em] kb-text-muted sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
                        Scenarios · 1-7
                      </div>
                      <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
                        Thread · T / C
                      </div>
                      <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
                        Sessions · 1-9 / J K
                      </div>
                      <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
                        Traces · 1-9 / J K / R
                      </div>
                    </div>
                    {/* The five surface cards used to be their own full-size card
                        grid — a fourth navigation system saying "jump to
                        section". Same destinations, one line each, inside the
                        one place an operator is meant to start. */}
                    <div className="mt-4 border-t kb-border-subtle pt-3">
                      <div className={`text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}>
                        {uxText('chronos_jump_to_section', locale)}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {statusCards.map((card) => {
                          const Icon = card.icon;
                          return (
                            <button
                              key={card.label}
                              type="button"
                              onClick={() => handleSectionJump(card.targetId)}
                              title={card.detail}
                              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] transition ${toneChipClass('neutral')}`}
                            >
                              <Icon size={11} />
                              <span>{card.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {activeScenario ? (
                    <section className="kyberion-glass rounded-[24px] border kb-border-accent kb-surface-accent p-4">
                      <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
                        Current
                      </div>
                      <div className="mt-1 text-sm font-semibold kb-text-primary">
                        {activeScenario.label}
                      </div>
                      <div className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                        <div className="text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                          Next
                        </div>
                        <div className="mt-1 text-[11px] leading-5 kb-text-secondary">
                          {activeScenario.nextStep}
                        </div>
                        <div className="mt-2 text-[9px] uppercase tracking-[0.18em] kb-text-muted">
                          Hotkey{' '}
                          {OPERATOR_SCENARIO_PRESETS.findIndex(
                            (scenario) => scenario.label === activeScenario.label
                          ) + 1}
                        </div>
                      </div>
                      {activeScenario.surface === 'mission-intelligence' ? (
                        <button
                          type="button"
                          onClick={() => setMissionIntelligenceFocus(null)}
                          className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                        >
                          Clear
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                </section>

                <section className="kyberion-glass rounded-[24px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4">
                  <button
                    onClick={() => toggleSection('views')}
                    aria-expanded={expandedSections.views}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] kb-text-muted hover:kb-text-primary transition"
                  >
                    <span>{uxText('chronos_nav_focus_views', locale)}</span>
                    {expandedSections.views ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.views && (
                    <>
                      <div className="mt-2 text-sm kb-text-secondary">
                        {uxText('chronos_nav_focus_views_hint', locale)}
                      </div>
                      <div className="mt-4 grid gap-2">
                        <button
                          type="button"
                          onClick={() => setFocusedOperatorView(null)}
                          className={`rounded-2xl border px-3 py-3 text-left transition ${
                            focusedOperatorView === null
                              ? 'kb-border-accent kb-surface-accent'
                              : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                          }`}
                        >
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            {uxText('chronos_nav_full_console', locale)}
                          </div>
                          <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                            {uxText('chronos_nav_full_console_hint', locale)}
                          </div>
                        </button>
                        {OPERATOR_VIEW_LINKS.map((view) => (
                          <button
                            key={view.targetId}
                            type="button"
                            onClick={() => handleOperatorViewOpen(view.targetId)}
                            className={`rounded-2xl border px-3 py-3 text-left transition ${
                              focusedOperatorView === view.targetId
                                ? 'kb-border-accent kb-surface-accent'
                                : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                            }`}
                          >
                            <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                              {view.label}
                            </div>
                            <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                              {view.detail}
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                {/* Diagnostics, not a starting point: 17 buttons competing with
                    the scenario list is what made the console read as a menu of
                    menus. Collapsed until something looks wrong. */}
                <section
                  id="operator-quick-actions"
                  className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-4 md:p-5"
                >
                  <button
                    type="button"
                    onClick={() => toggleSection('checks')}
                    aria-expanded={expandedSections.checks}
                    className={`flex w-full items-center justify-between gap-3 text-left transition ${shellTitleClass}`}
                  >
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
                        {uxText('chronos_nav_checks', locale)}
                      </div>
                      <div className="mt-1 text-sm kb-text-secondary">
                        {uxText('chronos_nav_checks_hint', locale)}
                      </div>
                    </div>
                    {expandedSections.checks ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>

                  <div className={expandedSections.checks ? 'mt-4 space-y-5' : 'hidden'}>
                    {quickActionGroups.map((group) => {
                      const Icon = group.icon;
                      return (
                        <div
                          key={group.title}
                          className="overflow-hidden rounded-2xl border kb-border-subtle kb-surface-sunken"
                        >
                          <div className={`bg-gradient-to-r ${group.accent} px-3 py-3`}>
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border kb-border-subtle kb-surface-raised/6">
                                <Icon size={14} className={group.accentText} />
                              </div>
                              <div>
                                <div
                                  className={`text-[11px] font-semibold uppercase tracking-[0.2em] ${group.accentText}`}
                                >
                                  {group.title}
                                </div>
                                <div className="mt-1 text-[11px] leading-5 kb-text-secondary">
                                  {group.hint}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="grid gap-2 p-3">
                            {group.actions.map((action) => (
                              <button
                                key={action.label}
                                onClick={() => handleQuickAction(action.query)}
                                className="flex items-center justify-between rounded-xl border kb-border-subtle kb-surface-well px-3 py-2 text-left transition hover:kb-border-subtle hover:kb-surface-well"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="text-sm">{action.icon}</div>
                                  <div>
                                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] kb-text-primary">
                                      {action.label}
                                    </div>
                                    <div className="text-[10px] uppercase tracking-[0.14em] kb-text-secondary">
                                      {action.tone}
                                    </div>
                                  </div>
                                </div>
                                <div className="text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                                  Run
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="kyberion-glass rounded-[24px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                  <button
                    onClick={() => toggleSection('taxonomy')}
                    aria-expanded={expandedSections.taxonomy}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] kb-text-muted hover:kb-text-primary transition"
                  >
                    <span>{uxText('chronos_screen_roles_title', locale)}</span>
                    {expandedSections.taxonomy ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.taxonomy && (
                    <>
                      <div className="mt-2 text-sm kb-text-secondary">
                        {uxText('chronos_screen_roles_description', locale)}
                      </div>
                      <div className="mt-4 space-y-3">
                        {SURFACE_ROLES.map((role) => (
                          <div
                            key={role.labelKey}
                            className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                {uxText(role.labelKey, locale)}
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                                {uxText(role.valueKey, locale)}
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                              {uxText(role.detailKey, locale)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                <section className="kyberion-glass rounded-[24px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                  <button
                    onClick={() => toggleSection('cycle')}
                    aria-expanded={expandedSections.cycle}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] kb-text-muted hover:kb-text-primary transition"
                  >
                    <span>{uxText('chronos_work_cycle_title', locale)}</span>
                    {expandedSections.cycle ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.cycle && (
                    <>
                      <div className="mt-2 text-sm kb-text-secondary">
                        {uxText('chronos_work_cycle_description', locale)}
                      </div>
                      <div className="mt-4 grid gap-2">
                        {MISSION_CYCLE.map((step, index) => (
                          <div
                            key={step.labelKey}
                            className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3"
                          >
                            <div className="flex items-center gap-3">
                              <div className="flex h-6 w-6 items-center justify-center rounded-full border kb-border-accent kb-surface-accent text-[10px] font-semibold kb-text-accent">
                                {index + 1}
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                {uxText(step.labelKey, locale)}
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                              {uxText(step.detailKey, locale)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                {/* Relocated from the top of the page. It describes how the
                    surface is themed — reference material for whoever is
                    styling it, never the operator's first question. */}
                <section className="kyberion-glass rounded-[24px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                  <button
                    onClick={() => toggleSection('designSystem')}
                    aria-expanded={expandedSections.designSystem}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] kb-text-muted hover:kb-text-primary transition"
                  >
                    <span>{uxText('chronos_nav_design_system', locale)}</span>
                    {expandedSections.designSystem ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.designSystem && (
                    <>
                      <div
                        className={`mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.24em] ${shellMutedClass}`}
                      >
                        <span>{webTheme.name}</span>
                        <span aria-hidden="true">·</span>
                        <span>{webDesignSystem.design_system.pack_id}</span>
                        <span aria-hidden="true">·</span>
                        <span>{webTheme.colors.accent}</span>
                      </div>
                      <div className="mt-3 grid gap-2">
                        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                          <div
                            className={`flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}
                          >
                            <Palette size={11} />
                            Theme
                          </div>
                          <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                            {webDesignSystem.theme.web.snapshot_summary}
                          </div>
                        </div>
                        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                          <div
                            className={`flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}
                          >
                            <LayoutGrid size={11} />
                            Layout
                          </div>
                          <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                            {webLayout.grid_columns}-column grid · container{' '}
                            {webLayout.container_max_width} · {webLayout.section_gap} section gap
                          </div>
                        </div>
                        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                          <div
                            className={`flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}
                          >
                            <Type size={11} />
                            Typography
                          </div>
                          <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                            {webTheme.fonts.heading}
                          </div>
                        </div>
                        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                          <div
                            className={`flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}
                          >
                            <Ruler size={11} />
                            Surface
                          </div>
                          <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                            {webLayout.panel_radius} / {webLayout.surface_radius}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {webDesignSystem.section_order.map((sectionId) => (
                          <span
                            key={sectionId}
                            className={`rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.16em] ${toneChipClass('neutral')}`}
                          >
                            {sectionId}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              </div>
            </aside>
          ) : null}

          <section
            ref={mainSurfaceRef}
            className="kyberion-glass flex min-h-[60vh] min-h-0 flex-col overflow-hidden rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.035),rgba(255,255,255,0.02))] xl:max-h-[calc(100vh-11rem)]"
          >
            <div className="flex items-center justify-between border-b kb-border-subtle px-5 py-4 md:px-6">
              <div>
                <div className="text-[10px] uppercase tracking-[0.34em] kb-text-muted">
                  {uxText('chronos_active_surface_heading', locale)}
                </div>
                <div className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                  {activeSurfaceTitle}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                  scope:{' '}
                  {[tenant, organizationId, projectId].filter(Boolean).join(' › ') ||
                    'not configured'}
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-full border kb-border-subtle kb-surface-sunken px-3 py-1 text-[10px] uppercase tracking-[0.22em] kb-text-secondary">
                <PanelsTopLeft size={12} />
                <span>
                  {surface
                    ? uxText('chronos_surface_mode_detail', locale)
                    : focusedOperatorView
                      ? uxText('chronos_surface_mode_operator', locale)
                      : missionIntelligenceFocus
                        ? uxText('chronos_surface_mode_mission', locale)
                        : uxText('chronos_surface_mode_default', locale)}
                </span>
              </div>
            </div>

            <div className="chronos-scroll min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
              {!surface ? (
                focusedOperatorView ? (
                  <FocusedOperatorView
                    tenant={tenant || undefined}
                    organizationId={organizationId || undefined}
                    projectId={projectId || undefined}
                    viewId={
                      focusedOperatorView as
                        | 'needs-attention'
                        | 'mission-control-plane'
                        | 'runtime-topology-map'
                        | 'runtime-lease-doctor'
                        | 'recent-surface-outbox'
                        | 'secret-approval-queue'
                        | 'owner-summaries'
                        | 'trace-viewer'
                    }
                    onBack={() => {
                      setFocusedOperatorView(null);
                      setFocusedOperatorMissionId(null);
                    }}
                    onOpenView={(targetId, missionId) =>
                      handleOperatorViewOpen(targetId, missionId || null)
                    }
                    focusedMissionId={focusedOperatorMissionId}
                    onOpenMissionThread={(missionId) =>
                      handleOperatorViewOpen('mission-control-plane', missionId)
                    }
                  />
                ) : (
                  <MissionIntelligence
                    tenant={tenant}
                    focusedView={missionIntelligenceFocus}
                    hideSurfaceControl
                    onClearFocus={() => {
                      setMissionIntelligenceFocus(null);
                      setMissionIntelligenceFocusedMissionId(null);
                    }}
                    focusedMissionId={missionIntelligenceFocusedMissionId}
                  />
                )
              ) : consoleSection === 'operations' ? (
                <AgentOpsBoards
                  onOpenMission={(missionId) =>
                    handleOperatorViewOpen('mission-control-plane', missionId)
                  }
                  onOpenView={(viewId) => handleOperatorViewOpen(viewId)}
                />
              ) : (
                <div className="flex flex-col gap-6">
                  {a2uiActionNotice ? (
                    <div className="rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[11px] kb-text-accent">
                      {a2uiActionNotice}
                    </div>
                  ) : null}
                  {surface.components?.map((component: any, index: number) => (
                    <A2UIRenderer
                      key={component.id || index}
                      type={component.type}
                      props={component.props || {}}
                      onAction={handleA2UIComponentAction}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {consoleSection === 'organization' ? (
        <OrganizationOperatingModel
          tenant={tenant || undefined}
          onOpenOperations={() => openConsoleSection('operations')}
          onOpenGovernance={() => openConsoleSection('governance')}
        />
      ) : null}

      {consoleSection === 'operations' ? (
        <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
                {uxText('chronos_nav_operations', locale)}
              </div>
              <h2 className="mt-1 text-xl font-semibold tracking-tight kb-text-primary">
                {uxText('chronos_office', locale)}
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 kb-text-secondary">
                {uxText('chronos_office_description', locale)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleScenarioOpen('mission-control-plane', 'mission-intelligence')}
              className="rounded-xl border kb-border-accent kb-surface-accent px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-accent"
            >
              {uxText('chronos_nav_active_surface', locale)} →
            </button>
          </div>
          <AgentOpsBoards
            tenant={tenant}
            onOpenMission={(missionId) =>
              handleOperatorViewOpen('mission-control-plane', missionId)
            }
            onOpenView={(viewId) => handleOperatorViewOpen(viewId)}
          />
          <details className="mt-6 rounded-2xl border kb-border-subtle kb-surface-sunken p-4">
            <summary className="cursor-pointer text-sm font-semibold kb-text-primary">
              {uxText('chronos_operations_mission_details_title', locale)}
              <span className="ml-2 text-[11px] font-normal kb-text-muted">
                {uxText('chronos_operations_mission_details_hint', locale)}
              </span>
            </summary>
            <div className="mt-4">
              <MissionIntelligence
                tenant={tenant}
                workspace="operations"
                onOpenWorkspace={(target) => openConsoleSection(target)}
              />
            </div>
          </details>
        </section>
      ) : null}

      {consoleSection === 'work-items' ? (
        <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
          <WorkItemsWorkspace
            tenant={tenant || undefined}
            organizationId={organizationId || undefined}
            projectId={projectId || undefined}
            onOpenMission={(missionId) =>
              handleOperatorViewOpen('mission-control-plane', missionId)
            }
          />
        </section>
      ) : null}

      {consoleSection === 'surface-control' ? (
        <>
          <SurfaceControlWorkspace tenant={tenant || undefined} />
          <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
            <MissionIntelligence
              tenant={tenant}
              workspace="surface-control"
              hideSurfaceControl
              onOpenWorkspace={(target) => openConsoleSection(target)}
            />
          </section>
        </>
      ) : null}

      {consoleSection === 'governance' ? (
        <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
          <div className="mb-5">
            <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
              {uxText('chronos_nav_governance', locale)}
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight kb-text-primary">
              {uxText('chronos_nav_governance_hint', locale)}
            </h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <button
              type="button"
              onClick={() => openConsoleSection('approvals')}
              className="rounded-2xl border kb-border-accent kb-surface-accent p-5 text-left transition hover:brightness-110"
            >
              <div className="text-[10px] uppercase tracking-[0.2em] kb-text-accent">
                {uxText('chronos_governance_approvals_label', locale)}
              </div>
              <div className="mt-2 text-lg font-semibold kb-text-primary">
                {uxText('chronos_governance_approvals_title', locale)}
              </div>
              <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                {uxText('chronos_governance_approvals_description', locale)}
              </div>
              <div className="mt-4 text-[10px] font-semibold uppercase tracking-[0.16em] kb-text-accent">
                {uxText('chronos_governance_approvals_action', locale)} →
              </div>
            </button>
            <button
              type="button"
              onClick={() => openConsoleSection('knowledge')}
              className="rounded-2xl border kb-border-accent kb-surface-accent p-5 text-left transition hover:brightness-110"
            >
              <div className="text-[10px] uppercase tracking-[0.2em] kb-text-accent">
                {uxText('chronos_governance_knowledge_label', locale)}
              </div>
              <div className="mt-2 text-lg font-semibold kb-text-primary">
                {uxText('chronos_governance_knowledge_title', locale)}
              </div>
              <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                {uxText('chronos_governance_knowledge_description', locale)}
              </div>
              <div className="mt-4 text-[10px] font-semibold uppercase tracking-[0.16em] kb-text-accent">
                {uxText('chronos_governance_knowledge_action', locale)} →
              </div>
            </button>
          </div>
          <div className="mt-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {uxText('chronos_governance_description', locale)}
          </div>
        </section>
      ) : null}

      {consoleSection === 'diagnostics' && focusedOperatorView ? (
        <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
          <FocusedOperatorView
            tenant={tenant || undefined}
            organizationId={organizationId || undefined}
            projectId={projectId || undefined}
            viewId={focusedOperatorView as any}
            onBack={() => {
              setFocusedOperatorView(null);
              setFocusedOperatorMissionId(null);
            }}
            onOpenView={(targetId, missionId) =>
              handleOperatorViewOpen(targetId, missionId || null)
            }
            focusedMissionId={focusedOperatorMissionId}
            onOpenMissionThread={(missionId) =>
              handleOperatorViewOpen('mission-control-plane', missionId)
            }
          />
        </section>
      ) : null}

      {consoleSection === 'diagnostics' ? (
        <DiagnosticsAttentionSummary
          tenant={tenant || undefined}
          onOpenView={(viewId, missionId) => handleOperatorViewOpen(viewId, missionId)}
        />
      ) : null}

      {consoleSection === 'surface' ? (
        <section
          ref={mainSurfaceRef}
          className="kyberion-glass flex min-h-[65vh] flex-col overflow-hidden rounded-[30px] border kb-border-accent bg-[linear-gradient(180deg,rgba(247,240,223,0.045),rgba(255,255,255,0.02))]"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b kb-border-subtle px-5 py-4 md:px-6">
            <div>
              <div className="text-[10px] uppercase tracking-[0.34em] kb-text-accent">
                {uxText('chronos_nav_active_surface', locale)}
              </div>
              <div className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                {activeSurfaceTitle}
              </div>
              <div className="mt-1 text-[11px] kb-text-secondary">
                {uxText('chronos_nav_active_surface_hint', locale)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => openConsoleSection(surfaceOrigin)}
              className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-2 text-[10px] font-bold uppercase tracking-[0.16em] kb-text-secondary hover:kb-surface-raised"
            >
              ← {uxText('chronos_cb_back', locale)}
            </button>
          </div>
          <div className="chronos-scroll min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
            {surface ? (
              <div className="flex flex-col gap-6">
                {a2uiActionNotice ? (
                  <div className="rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[11px] kb-text-accent">
                    {a2uiActionNotice}
                  </div>
                ) : null}
                {surface.components?.map((component: any, index: number) => (
                  <A2UIRenderer
                    key={component.id || index}
                    type={component.type}
                    props={component.props || {}}
                    onAction={handleA2UIComponentAction}
                  />
                ))}
              </div>
            ) : focusedOperatorView ? (
              <FocusedOperatorView
                tenant={tenant || undefined}
                organizationId={organizationId || undefined}
                projectId={projectId || undefined}
                viewId={focusedOperatorView as any}
                onBack={() => {
                  setFocusedOperatorView(null);
                  setFocusedOperatorMissionId(null);
                }}
                onOpenView={(targetId, missionId) =>
                  handleOperatorViewOpen(targetId, missionId || null)
                }
                focusedMissionId={focusedOperatorMissionId}
                onOpenMissionThread={(missionId) =>
                  handleOperatorViewOpen('mission-control-plane', missionId)
                }
              />
            ) : (
              <div className="flex flex-col gap-6">
                <MissionIntelligence
                  tenant={tenant}
                  focusedView={missionIntelligenceFocus}
                  hideSurfaceControl
                  onClearFocus={() => {
                    setMissionIntelligenceFocus(null);
                    setMissionIntelligenceFocusedMissionId(null);
                  }}
                  focusedMissionId={missionIntelligenceFocusedMissionId}
                />
                <HeadlessA2UIWorkspace
                  tenant={tenant || undefined}
                  organizationId={organizationId || undefined}
                  projectId={projectId || undefined}
                />
              </div>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
