import { Activity, Bot, Brain, GitBranch, Radar, Send, ShieldAlert } from 'lucide-react';
import { SurfaceStatusPanel } from './SurfaceStatusPanel';
import {
  attentionActionLabel,
  attentionNextStepLabel,
  attentionReasonLabel,
  attentionSourceLabel,
} from './MissionIntelligenceViewHelpers';
import { MiniSummaryCard, Panel } from './MissionIntelligencePrimitives';

export function MissionIntelligenceSurfaceOverview(context: Record<string, any>) {
  const {
    workspace,
    focusedView,
    selectedProject,
    selectedMissionId,
    showMissionDetails,
    setShowMissionDetails,
    mt,
    data,
    attentionItems,
    missionExceptions,
    surfaceExceptions,
    deliveryExceptions,
    panelVisible,
    nextActions,
    nextAction,
    nextActionTarget,
    runNextAction,
    jumpToNextActionRoute,
    selectedTrack,
    selectedProjectManagement,
    selectedMission,
    setSelectedMissionId,
    setSelectedProjectId,
    setSelectedTrackId,
    memoryPromotionTarget,
    actionResult,
    runMemoryPromotion,
    runAttentionAction,
    focusTitle,
    memoryCandidateCount,
  } = context;

  return (
    <>
      {workspace === 'missions' ? (
        <section className="rounded-2xl border kb-border-accent kb-surface-accent px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.22em] kb-text-accent">
                {mt('chronos_mission_overview_eyebrow', 'Mission overview')}
              </div>
              <div className="mt-1 text-[11px] leading-5 kb-text-secondary">
                {mt(
                  'chronos_mission_overview_hint',
                  'Start with the goal, current state, and next step. Open related information only when you need it.'
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowMissionDetails((current) => !current)}
              className="self-start rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2 text-[10px] font-bold tracking-[0.12em] kb-text-secondary transition hover:kb-border-accent hover:kb-text-accent"
            >
              {showMissionDetails
                ? mt('chronos_hide_mission_details', 'Hide related information')
                : mt('chronos_show_mission_details', 'Show related information')}
            </button>
          </div>
        </section>
      ) : null}
      {/* Command Center: High-Visibility Action Dashboard */}
      {workspace === 'surface' && !selectedProject && !selectedMissionId && (
        <section className="flex flex-col gap-8 py-4">
          <div className="flex flex-col gap-2">
            <div className="text-[12px] uppercase tracking-[0.4em] kb-text-accent font-bold">
              Sovereign Command
            </div>
            <h2 className="text-3xl font-bold tracking-tight kb-text-primary">
              Welcome to the Mirror.
            </h2>
            <p className="text-sm kb-text-muted max-w-2xl leading-relaxed">
              Chronos is your operational管制塔. Use the tiles below to start monitoring or
              intervene in active agent workflows.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <button
              onClick={() =>
                document
                  .getElementById('mission-control-plane')
                  ?.scrollIntoView({ behavior: 'smooth' })
              }
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:kb-border-accent transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl kb-surface-accent flex items-center justify-center kb-text-accent mb-6 group-hover:scale-110 transition-transform">
                <Radar size={28} />
              </div>
              <h3 className="text-xl font-bold kb-text-primary mb-2">Monitor Missions</h3>
              <p className="text-xs kb-text-muted leading-relaxed">
                Observe real-time intent execution and artifact delivery across all active agents.
              </p>
              <div className="mt-6 text-[10px] uppercase tracking-widest kb-text-accent font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                Open Dashboard →
              </div>
            </button>

            <button
              onClick={() =>
                document
                  .getElementById('runtime-lease-doctor')
                  ?.scrollIntoView({ behavior: 'smooth' })
              }
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:kb-status-warning-border transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl kb-status-warning-surface flex items-center justify-center kb-status-warning mb-6 group-hover:scale-110 transition-transform">
                <Activity size={28} />
              </div>
              <h3 className="text-xl font-bold kb-text-primary mb-2">System Health</h3>
              <p className="text-xs kb-text-muted leading-relaxed">
                Inspect runtime leases, remediation findings, and supervisor-level governance.
              </p>
              <div className="mt-6 text-[10px] uppercase tracking-widest kb-status-warning font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                Check Vitals →
              </div>
            </button>

            <button
              onClick={() =>
                document
                  .getElementById('recent-surface-outbox')
                  ?.scrollIntoView({ behavior: 'smooth' })
              }
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:kb-status-negative-border transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl kb-status-negative-surface flex items-center justify-center kb-status-negative mb-6 group-hover:scale-110 transition-transform">
                <ShieldAlert size={28} />
              </div>
              <h3 className="text-xl font-bold kb-text-primary mb-2">Intervention</h3>
              <p className="text-xs kb-text-muted leading-relaxed">
                Resolve blocked deliveries, approve sensitive requests, and manage exceptions.
              </p>
              <div className="mt-6 text-[10px] uppercase tracking-widest kb-status-negative font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                View Outbox →
              </div>
            </button>
          </div>

          <div className="kyberion-glass p-6 rounded-[24px] kb-border-subtle flex items-center justify-between kb-surface-raised">
            <div className="flex items-center gap-4">
              <div className="w-2 h-2 rounded-full kb-surface-accent pulse-animation" />
              <div className="text-[11px] uppercase tracking-[0.2em] kb-text-secondary">
                System Status: <span className="kb-text-accent font-bold">Nominal</span>
              </div>
            </div>
            <div className="text-[10px] kb-text-muted font-mono">
              Ready for operator commands via Sovereign Link or Quick Actions.
            </div>
          </div>
        </section>
      )}

      {workspace === 'surface' && focusedView && (
        <section className="rounded-[24px] border kb-border-accent kb-surface-accent px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
                Focused Operator View
              </div>
              <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                {focusTitle}
              </div>
              <div className="mt-1 text-[11px] leading-5 kb-text-muted">
                The main console is showing one operator view at full width.
              </div>
            </div>
            {onClearFocus && (
              <button
                type="button"
                onClick={onClearFocus}
                className="self-start rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.2em] kb-text-secondary transition hover:kb-surface-raised"
              >
                Show Full Console
              </button>
            )}
          </div>
        </section>
      )}
      {workspace === 'surface' ? (
        <section className="rounded-[26px] border kb-status-warning-border bg-gradient-to-br from-[var(--kb-status-warning-surface)] via-[var(--kb-surface-raised)] to-[var(--kb-surface-sunken)] px-5 py-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] kb-status-warning">
                {mt('chronos_operator_console', 'Operator Console')}
              </div>
              <h2 className="mt-2 text-xl font-semibold tracking-tight kb-text-primary">
                {mt(
                  'chronos_mission_hero_title',
                  'Start with exceptions, then intervene only where mission flow or runtime governance needs help.'
                )}
              </h2>
              <p className="mt-2 max-w-3xl text-[12px] leading-6 kb-text-muted">
                {mt(
                  'chronos_mission_hero_description',
                  'Chronos is the operational mirror for Kyberion. Confirm what is active, identify what is blocked, open A2UI drill-downs when you need detail, and keep control actions deliberate and minimal.'
                )}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-[10px] uppercase tracking-[0.18em] kb-text-muted sm:grid-cols-4">
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div>{mt('chronos_sc_needs_attention_label', 'Needs attention')}</div>
                <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                  {attentionItems.length}
                </div>
              </div>
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div>{mt('chronos_missions_label', 'Missions')}</div>
                <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                  {data.activeMissions.length}
                </div>
              </div>
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div>{mt('chronos_runtime_incidents', 'Runtime incidents')}</div>
                <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                  {data.runtimeDoctor.length}
                </div>
              </div>
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div>{mt('chronos_delivery_queue', 'Delivery queue')}</div>
                <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                  {data.surfaceOutbox.slack + data.surfaceOutbox.chronos}
                </div>
              </div>
            </div>
          </div>
          {actionResult && (
            <div className="mt-4 rounded-xl border kb-border-accent kb-surface-accent px-3 py-2 text-[11px] kb-text-accent">
              {mt('chronos_last_action', 'last action')}: {actionResult}
            </div>
          )}
          <div className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] kb-text-secondary">
            {mt('chronos_access', 'access')}:{' '}
            <span className="font-mono kb-text-primary">{data.accessRole}</span>
            {data.accessRole === 'readonly'
              ? mt(
                  'chronos_control_actions_disabled',
                  ' · control actions are disabled until a localadmin token is provided or localhost auto-admin is enabled.'
                )
              : mt('chronos_control_actions_enabled', ' · control actions enabled.')}
          </div>
          {data.company && (
            <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent px-3 py-3 text-[11px] kb-text-accent">
              <div className="text-[10px] uppercase tracking-[0.24em] kb-text-accent">
                Company Context
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] kb-text-primary">
                <span className="font-semibold kb-text-primary">{data.company.name}</span>
                <span className="kb-text-muted">·</span>
                <span className="font-mono kb-text-secondary">{data.company.companyId}</span>
                <span className="kb-text-muted">·</span>
                <span className="kb-text-secondary">
                  sovereign {data.company.sovereign || 'unknown'}
                </span>
              </div>
              <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                vision <span className="font-mono kb-text-primary">{data.company.visionRef}</span>
                <span className="mx-2 kb-text-muted">·</span>
                <span>{data.company.vision.title || data.company.vision.sourcePath}</span>
              </div>
              <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                org chart {data.company.orgChart.positionCount} positions /{' '}
                {data.company.orgChart.domainCount} domains
                {data.company.orgChart.topLevelRoles.length > 0 ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    top roles {data.company.orgChart.topLevelRoles.join(', ')}
                  </>
                ) : null}
              </div>
              <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                decision rights {data.company.decisionRights.ruleCount} rules
                {data.company.decisionRights.sourceKind ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.decisionRights.sourceKind}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                financial {data.company.financial.exists ? 'available' : 'missing'}
                {data.company.financial.exists ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.financial.periodCount} period
                    {data.company.financial.periodCount === 1 ? '' : 's'}
                    {data.company.financial.latestPeriodId ? (
                      <>
                        <span className="mx-2 kb-text-muted">·</span>
                        latest {data.company.financial.latestPeriodId}
                      </>
                    ) : null}
                    {typeof data.company.financial.latestGrossProfitJpy === 'number' ? (
                      <>
                        <span className="mx-2 kb-text-muted">·</span>
                        gross profit ¥
                        {data.company.financial.latestGrossProfitJpy.toLocaleString(
                          chronosSpeechLocale()
                        )}
                      </>
                    ) : null}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                finance controller {data.company.financeController.mode}
                {data.company.financeController.shouldCutCosts ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    cost cutting
                  </>
                ) : null}
                {data.company.financeController.reasons.length > 0 ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.financeController.reasons.length} reason
                    {data.company.financeController.reasons.length === 1 ? '' : 's'}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                OKR {data.company.okr.exists ? 'available' : 'missing'}
                {data.company.okr.exists ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.okr.objectiveCount} objective
                    {data.company.okr.objectiveCount === 1 ? '' : 's'}
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.okr.keyResultCount} KR
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.okr.progressPercent}% progress
                    {data.company.okr.latestObjective ? (
                      <>
                        <span className="mx-2 kb-text-muted">·</span>
                        latest {data.company.okr.latestObjective}
                      </>
                    ) : null}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                audit {data.company.approvalAudit.total}
                <span className="mx-2 kb-text-muted">·</span>
                allowed {data.company.approvalAudit.allowed}
                <span className="mx-2 kb-text-muted">·</span>
                denied {data.company.approvalAudit.denied}
                {data.company.approvalAudit.latestCorrelationId ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    latest {data.company.approvalAudit.latestCorrelationId}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                audit drilldown {data.company.approvalAuditDrilldown.byDecisionType.length} types /{' '}
                {data.company.approvalAuditDrilldown.byCorrelationId.length} chains
              </div>
            </div>
          )}
          {selectedProject && (
            <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent px-3 py-3 text-[11px] kb-text-accent">
              project focus:{' '}
              <span className="font-semibold kb-text-primary">{selectedProject.name}</span>
              <span className="mx-2 kb-text-muted">·</span>
              <span className="font-mono kb-text-secondary">{selectedProject.project_id}</span>
              {selectedProjectManagement ? (
                <>
                  <span className="mx-2 kb-text-muted">·</span>
                  <span className="kb-text-primary">
                    {selectedProjectManagement.lineage.tasks.length} tasks /{' '}
                    {selectedProjectManagement.lineage.task_sessions.length} task sessions
                  </span>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setSelectedProjectId(null)}
                className="ml-3 rounded-lg border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
              >
                clear focus
              </button>
            </div>
          )}
          {selectedMission && (
            <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent px-3 py-3 text-[11px] kb-text-accent">
              mission focus:{' '}
              <span className="font-semibold kb-text-primary">{selectedMission.missionId}</span>
              <span className="mx-2 kb-text-muted">·</span>
              <span className="kb-text-primary">
                {buildMissionIntentSummary(data, selectedMission)}
              </span>
              <button
                type="button"
                onClick={() => setSelectedMissionId(null)}
                className="ml-3 rounded-lg border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
              >
                clear focus
              </button>
            </div>
          )}
          {selectedTrack && (
            <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent px-3 py-3 text-[11px] kb-text-accent">
              track focus:{' '}
              <span className="font-semibold kb-text-primary">{selectedTrack.name}</span>
              <span className="mx-2 kb-text-muted">·</span>
              <span className="font-mono kb-text-secondary">{selectedTrack.track_id}</span>
              <button
                type="button"
                onClick={() => setSelectedTrackId(null)}
                className="ml-3 rounded-lg border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
              >
                clear focus
              </button>
            </div>
          )}
          <div className="mt-3 rounded-xl border kb-status-warning-border kb-surface-raised-subtle px-3 py-3 text-[11px] leading-5 kb-text-secondary">
            {mt(
              'chronos_surface_explanation',
              'Surfaces are the explainable boundary between people and agent execution. Chronos clarifies mission flow, runtime risk, and intervention points before offering controls.'
            )}
          </div>
        </section>
      ) : null}

      {workspace === 'surface' ? (
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard
            icon={<ShieldAlert size={14} />}
            label={mt('chronos_attention_queue', 'Needs Attention')}
            value={String(attentionItems.length)}
            detail={mt(
              'chronos_attention_queue_detail',
              'Mission blockers, runtime incidents, and delivery exceptions'
            )}
          />
          <MetricCard
            icon={<Bot size={14} />}
            label={mt('chronos_runtime_governance', 'Runtime governance')}
            value={`${data.runtimeDoctor.length}/${data.runtimeLeases.length}`}
            detail={`ready=${data.runtime.ready} busy=${data.runtime.busy} error=${data.runtime.error}`}
          />
          <MetricCard
            icon={<Send size={14} />}
            label={mt('chronos_delivery_exceptions', 'Delivery exceptions')}
            value={String(data.surfaceOutbox.slack + data.surfaceOutbox.chronos)}
            detail={mt(
              'chronos_delivery_exceptions_detail',
              'Outbox entries awaiting operator attention'
            )}
          />
          <MetricCard
            icon={<Brain size={14} />}
            label={mt('chronos_memory_promotion', 'Learning registration')}
            value={String(memoryCandidateCount)}
            detail={
              nextAction
                ? `${mt('chronos_next_action_prefix', '次')}: ${nextAction.reason}`
                : mt('chronos_memory_no_action', 'No learning needs to be registered now')
            }
          />
        </div>
      ) : null}

      {workspace === 'surface' && !focusedView ? (
        <SurfaceStatusPanel
          eyebrow="Active Surface"
          title="Select a mission or task to open its focused surface"
          detail="Active Surface is intentionally limited to the current task context. Use Missions, Work Items, or Operations to choose what to inspect."
          tone="info"
        />
      ) : null}

      <section className="grid gap-4">
        <Panel
          id="next-actions"
          visible={panelVisible('next-actions')}
          title={mt('chronos_recommended_next_actions', 'What to check next')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_recommended_next_actions_detail',
              'Suggestions based on the current state. Run only the actions needed to move the mission forward.'
            )}
          </div>
          <div className="mb-4 rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[10px] leading-5 kb-text-accent">
            {mt('chronos_mission_seed_assessment', 'Mission candidate status')}:{' '}
            {mt('chronos_eligible', 'Ready to start')}{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.eligible ?? 0}
            </span>
            {' · '}
            {mt('chronos_flagged', 'Needs review')}{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.flagged ?? 0}
            </span>
            {' · '}
            {mt('chronos_promotable', 'Can become a mission')}{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.promotable ?? 0}
            </span>
          </div>
          <div className="space-y-3">
            {nextActions.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_immediate_next_actions', 'There are no actions needed right now.')}
              </div>
            ) : (
              nextActions.map((action) => (
                <div
                  key={action.action_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                      {action.action_id}
                    </div>
                    <div className="rounded-full kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-accent">
                      {action.next_action_type}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] kb-text-secondary">{action.reason}</div>
                  <div className="mt-2 text-[10px] kb-text-muted">
                    {mt('chronos_risk', 'Risk')}:{' '}
                    <span className="font-mono kb-text-secondary">{action.risk}</span>
                    <span className="mx-2 kb-text-muted">·</span>
                    {mt('chronos_approval_required', 'Approval needed')}:{' '}
                    <span className="font-mono kb-text-secondary">
                      {action.approval_required ? mt('chronos_yes', 'Yes') : mt('chronos_no', 'No')}
                    </span>
                  </div>
                  {resolveNextActionRoute(action) ? (
                    <div className="mt-1 text-[10px] kb-text-muted">
                      {mt('chronos_route', 'Destination')}:{' '}
                      <span className="font-mono kb-text-secondary">
                        {resolveNextActionRoute(action)?.label}
                      </span>
                    </div>
                  ) : null}
                  {action.suggested_command ? (
                    <div className="mt-1 text-[10px] kb-text-muted">
                      {mt('chronos_command', 'Command')}:{' '}
                      <span className="font-mono kb-text-secondary">
                        {action.suggested_command}
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {resolveNextActionRoute(action) ? (
                      <button
                        type="button"
                        onClick={() => jumpToNextActionRoute(action)}
                        className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
                      >
                        {mt('chronos_jump', 'Open')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => runNextAction(action)}
                      disabled={nextActionTarget === action.action_id}
                      className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {nextActionTarget === action.action_id
                        ? mt('chronos_processing', 'processing')
                        : mt('chronos_execute', 'Run')}
                    </button>
                    {action.action_id === 'chronos-promote-memory' ? (
                      <button
                        type="button"
                        onClick={() => runMemoryPromotion(true)}
                        disabled={memoryPromotionTarget !== null}
                        className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {memoryPromotionTarget === 'dry-run'
                          ? mt('chronos_processing', 'processing')
                          : mt('chronos_dry_run', 'Preview')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="needs-attention"
          visible={panelVisible('needs-attention')}
          title={mt('chronos_needs_attention_panel', 'Items needing attention')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_needs_attention_detail',
              'Prioritized items to review. Each item shows why it matters, where it came from, and the next safe step.'
            )}
          </div>
          <div className="grid gap-3 lg:grid-cols-[1.15fr,0.85fr]">
            <div className="space-y-3">
              {attentionItems.length === 0 ? (
                <div className="rounded-xl border kb-status-positive-border kb-status-positive-surface px-4 py-3 text-[11px] kb-status-positive">
                  {mt(
                    'chronos_no_operator_intervention',
                    'No immediate action is needed. Open details if you need to investigate further.'
                  )}
                </div>
              ) : (
                attentionItems.map((item) => (
                  <div
                    key={item.id}
                    className={`rounded-xl border px-4 py-3 ${
                      item.tone === 'critical'
                        ? 'kb-status-negative-border kb-status-negative-surface'
                        : item.tone === 'warning'
                          ? 'kb-status-warning-border kb-status-warning-surface'
                          : 'kb-border-accent kb-surface-accent'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                        {item.tone === 'critical'
                          ? mt('chronos_critical', 'Urgent')
                          : item.tone === 'warning'
                            ? mt('chronos_warning', 'Caution')
                            : mt('chronos_info', 'Information')}
                      </div>
                      <div className="text-[10px] font-mono kb-text-muted">{item.title}</div>
                    </div>
                    <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
                      <div className="rounded-lg border kb-border-subtle kb-surface-sunken p-2">
                        <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                          {mt('chronos_why_now', 'Why check now')}
                        </div>
                        <div className="mt-1 kb-text-secondary">
                          {attentionReasonLabel(item, locale)}
                        </div>
                      </div>
                      <div className="rounded-lg border kb-border-subtle kb-surface-sunken p-2">
                        <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                          {mt('chronos_source_next_step', 'Source and next step')}
                        </div>
                        <div className="mt-1 kb-text-secondary">
                          {attentionSourceLabel(item, locale)}
                        </div>
                        {item.nextStep ? (
                          <div className="mt-1 kb-text-muted">
                            {attentionNextStepLabel(item, locale)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {item.actionLabel && (
                      <button
                        type="button"
                        onClick={() => runAttentionAction(item)}
                        className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
                      >
                        {attentionActionLabel(item, locale)}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <MiniSummaryCard
                icon={<GitBranch size={13} />}
                label={mt('chronos_work_needing_attention', 'Work to review')}
                value={missionExceptions.length}
                detail={mt(
                  'chronos_work_needing_attention_detail',
                  'Requests or missions that need a person to check them'
                )}
              />
              <MiniSummaryCard
                icon={<Bot size={13} />}
                label={mt('chronos_runtime_incidents', 'Runtime issues')}
                value={data.runtimeDoctor.length}
                detail={mt(
                  'chronos_runtime_incidents_detail',
                  'Execution environments with a diagnostic issue'
                )}
              />
              <MiniSummaryCard
                icon={<Radar size={13} />}
                label={mt('chronos_surface_incidents', 'Surface issues')}
                value={surfaceExceptions.length}
                detail={mt('chronos_surface_incidents_detail', 'Managed surfaces that need review')}
              />
              <MiniSummaryCard
                icon={<Send size={13} />}
                label={mt('chronos_delivery_exceptions', 'Delivery issues')}
                value={deliveryExceptions.length}
                detail={mt(
                  'chronos_delivery_exceptions_detail',
                  'Pending or leftover delivery issues'
                )}
              />
            </div>
          </div>
        </Panel>
      </section>
    </>
  );
}
