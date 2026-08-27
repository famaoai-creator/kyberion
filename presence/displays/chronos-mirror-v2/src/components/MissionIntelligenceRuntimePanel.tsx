import {
  Activity,
  AlertTriangle,
  Bot,
  Brain,
  GitBranch,
  Radar,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { SurfaceStatusPanel } from './SurfaceStatusPanel';
import {
  ActionDetailList,
  ActionGuidance,
  ActionStatusBadge,
  actionButtonClass,
  getActionDefinition,
  getGlobalSurfaceControlAction,
  getLatestSurfaceControlAction,
  messageToneClass,
  messageTypeLabel,
  missionStatusLabel,
  toDomId,
} from './MissionIntelligenceViewHelpers';
import { Panel, RuntimeCell } from './MissionIntelligencePrimitives';
import { chronosSpeechLocale } from '../lib/ux-vocabulary';

export function MissionIntelligenceRuntimePanel(context: Record<string, any>) {
  const {
    data,
    locale,
    mt,
    panelVisible,
    runtime,
    runtimeLeases,
    runtimeDoctor,
    runtimeTopology,
    recentSurfaceOutbox,
    browserSessionTarget,
    surfaceActionTarget,
    expandedSurfaceCardActionId,
    filteredMissions,
    filteredAgentMessages,
    filteredA2AHandoffs,
    missionThread,
    effectiveMissionId,
    missionPinStatusLabel,
    focusMissionCard,
    runBrowserSessionControl,
    runSurfaceControl,
    setBrowserSessionTarget,
    setSurfaceActionTarget,
    setExpandedSurfaceCardActionId,
    setSelectedMissionId,
    setMessageMissionFilter,
    selectedMissionId,
    missionExceptions,
    surfaceExceptions,
    deliveryExceptions,
    selectedProject,
    selectedProjectId,
    selectedTrackId,
    selectedProjectBootstrapItems,
    selectedReferencePath,
    referenceDetail,
    referenceMetadataEntries,
    referenceSections,
    openKnowledgeReference,
    openRuntimeReference,
    clearOutboxMessage,
    outboxTarget,
    setOutboxTarget,
    remediationTarget,
    remediateLease,
    setRemediationTarget,
    requestDangerousAction,
    clearDangerousAction,
    confirmDangerousAction,
    dangerousAction,
    actionResult,
    setActionResult,
    selectedProjectManagement,
    filteredServiceBindings,
    filteredMissionSeedsByTrack,
    hydratedTracks,
    missionProgress,
    projectManagement,
    missionSeedAssessment,
    selectedTrack,
  } = context;

  return (
    <>
      <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
        <Panel
          id="orchestration-audit"
          visible={panelVisible('orchestration-audit')}
          title="Orchestration Audit"
        >
          <div className="space-y-3">
            {data.recentEvents.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No orchestration events yet.
              </div>
            ) : (
              data.recentEvents.map((event, index) => (
                <div
                  key={`${event.ts}-${index}`}
                  className="border-l kb-status-warning-border pl-3"
                >
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                    <Activity size={10} />
                    <span>{event.decision}</span>
                  </div>
                  <div className="mt-1 text-[11px] kb-text-primary">
                    {event.mission_id || 'system'}
                  </div>
                  {event.why && <div className="mt-1 text-[10px] kb-text-muted">{event.why}</div>}
                  <div className="mt-1 text-[9px] font-mono kb-text-muted">
                    {new Date(event.ts).toLocaleString(chronosSpeechLocale())}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
        <Panel
          id="owner-summaries"
          visible={panelVisible('owner-summaries')}
          title={mt('chronos_owner_summaries', 'Owner summaries')}
        >
          <div className="space-y-3">
            {data.ownerSummaries.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_owner_summaries', 'No owner summaries yet.')}
              </div>
            ) : (
              data.ownerSummaries.map((summary, index) => (
                <div
                  key={`${summary.mission_id}-${summary.ts}-${index}`}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                      {summary.mission_id}
                    </div>
                    <div className="text-[9px] font-mono kb-text-muted">
                      {new Date(summary.ts).toLocaleString(chronosSpeechLocale())}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-secondary">
                    <div>
                      accepted:{' '}
                      <span className="font-mono kb-text-primary">{summary.accepted_count}</span>
                    </div>
                    <div>
                      reviewed:{' '}
                      <span className="font-mono kb-text-primary">{summary.reviewed_count}</span>
                    </div>
                    <div>
                      completed:{' '}
                      <span className="font-mono kb-text-primary">{summary.completed_count}</span>
                    </div>
                    <div>
                      requested:{' '}
                      <span className="font-mono kb-text-primary">{summary.requested_count}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="runtime-summary"
          visible={panelVisible('runtime-summary')}
          title="Operator Summary"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Keep the operator loop narrow: look at exceptions first, then mission readiness, then
            runtime and delivery counters. When these stay green, use quick actions to open governed
            A2UI drill-downs rather than adding more controls here.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <RuntimeCell label="ready" value={data.runtime.ready} accent="emerald" />
            <RuntimeCell label="busy" value={data.runtime.busy} accent="gold" />
            <RuntimeCell label="error" value={data.runtime.error} accent="red" />
            <RuntimeCell label="leases" value={data.runtimeLeases.length} accent="cyan" />
            <RuntimeCell label="slack outbox" value={data.surfaceOutbox.slack} accent="gold" />
            <RuntimeCell label="chronos outbox" value={data.surfaceOutbox.chronos} accent="cyan" />
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
        <Panel
          id="browser-sessions"
          visible={panelVisible('browser-sessions')}
          title="Browser Session Oversight"
        >
          <div className="space-y-3">
            {data.browserSessions.length === 0 ? (
              <SurfaceStatusPanel
                eyebrow="Browser Session Oversight"
                title="No browser sessions recorded yet"
                detail="Open a browser task or capture a session to populate the registry."
                tone="neutral"
              />
            ) : (
              data.browserSessions.map((session) => (
                <div
                  key={session.session_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                        {session.session_id}
                      </div>
                      <div className="mt-1 text-[10px] kb-text-muted">
                        active tab:{' '}
                        <span className="font-mono kb-text-secondary">{session.active_tab_id}</span>{' '}
                        · tabs:{' '}
                        <span className="font-mono kb-text-secondary">{session.tab_count}</span>
                      </div>
                    </div>
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                        session.lease_status === 'active'
                          ? 'kb-surface-accent kb-text-accent'
                          : session.lease_status === 'expired'
                            ? 'kb-status-warning-surface kb-status-warning'
                            : 'kb-surface-raised kb-text-secondary'
                      }`}
                    >
                      {session.lease_status}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      retained:{' '}
                      <span className="font-mono kb-text-primary">{String(session.retained)}</span>
                    </div>
                    <div>
                      trail:{' '}
                      <span className="font-mono kb-text-primary">
                        {session.action_trail_count}
                      </span>
                    </div>
                    <div>
                      updated:{' '}
                      <span className="font-mono kb-text-primary">
                        {new Date(session.updated_at).toLocaleTimeString(chronosSpeechLocale())}
                      </span>
                    </div>
                    <div>
                      lease expires:{' '}
                      <span className="font-mono kb-text-primary">
                        {session.lease_expires_at
                          ? new Date(session.lease_expires_at).toLocaleTimeString(
                              chronosSpeechLocale()
                            )
                          : 'n/a'}
                      </span>
                    </div>
                  </div>
                  {session.last_trace_path && (
                    <div className="mt-2 text-[10px] kb-text-muted">
                      trace:{' '}
                      <span className="font-mono kb-text-secondary">{session.last_trace_path}</span>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        runBrowserSessionControl(session.session_id, 'close_browser_session')
                      }
                      disabled={
                        browserSessionTarget === `${session.session_id}:close_browser_session` ||
                        session.lease_status !== 'active'
                      }
                      className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {browserSessionTarget === `${session.session_id}:close_browser_session`
                        ? 'closing'
                        : 'close session'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        runBrowserSessionControl(session.session_id, 'restart_browser_session')
                      }
                      disabled={
                        browserSessionTarget === `${session.session_id}:restart_browser_session`
                      }
                      className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {browserSessionTarget === `${session.session_id}:restart_browser_session`
                        ? 'restarting'
                        : 'restart session'}
                    </button>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      recent browser trail
                    </div>
                    {session.recent_actions.length === 0 ? (
                      <div className="text-[10px] kb-text-muted">No recorded browser actions.</div>
                    ) : (
                      session.recent_actions.map((action, index) => (
                        <div
                          key={`${session.session_id}-${action.ts}-${index}`}
                          className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                              {action.kind} · {action.op}
                            </div>
                            <div className="text-[9px] font-mono kb-text-muted">
                              {new Date(action.ts).toLocaleTimeString(chronosSpeechLocale())}
                            </div>
                          </div>
                          <div className="mt-1 text-[10px] kb-text-muted">
                            {action.tab_id && (
                              <span className="mr-2">
                                tab:{' '}
                                <span className="font-mono kb-text-secondary">{action.tab_id}</span>
                              </span>
                            )}
                            {action.ref && (
                              <span className="mr-2">
                                ref:{' '}
                                <span className="font-mono kb-text-secondary">{action.ref}</span>
                              </span>
                            )}
                            {action.selector && (
                              <span>
                                selector:{' '}
                                <span className="font-mono kb-text-muted">{action.selector}</span>
                              </span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="browser-guidance"
          visible={panelVisible('browser-guidance')}
          title="Browser Guidance"
        >
          <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Browser sessions stay fast only while they are leased. Prefer `snapshot + ref`, then
            export recorded trails as Playwright specs in either strict or hint mode.
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <RuntimeCell
              label="browser sessions"
              value={data.browserSessions.length}
              accent="cyan"
            />
            <RuntimeCell
              label="active leases"
              value={
                data.browserSessions.filter((session) => session.lease_status === 'active').length
              }
              accent="emerald"
            />
            <RuntimeCell
              label="retained"
              value={data.browserSessions.filter((session) => session.retained).length}
              accent="gold"
            />
            <RuntimeCell
              label="expired"
              value={
                data.browserSessions.filter((session) => session.lease_status === 'expired').length
              }
              accent="red"
            />
          </div>
        </Panel>
        <Panel
          id="browser-conversation-sessions"
          visible={panelVisible('browser-conversation-sessions')}
          title="Browser Tasks"
        >
          <div className="space-y-3">
            {data.browserConversationSessions.length === 0 ? (
              <SurfaceStatusPanel
                eyebrow="Browser Tasks"
                title="No browser tasks recorded yet"
                detail="Start a task from the browser surface to capture guided confirmations and result state."
                tone="neutral"
              />
            ) : (
              data.browserConversationSessions.map((session) => (
                <div
                  key={session.session_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                        {session.session_id}
                      </div>
                      <div className="mt-1 text-[10px] kb-text-muted">
                        surface:{' '}
                        <span className="font-mono kb-text-secondary">{session.surface}</span> ·
                        mode: <span className="font-mono kb-text-secondary">{session.mode}</span>
                      </div>
                    </div>
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                        session.status === 'completed'
                          ? 'kb-status-positive-surface kb-status-positive'
                          : session.status === 'awaiting_confirmation'
                            ? 'kb-status-warning-surface kb-status-warning'
                            : session.status === 'failed'
                              ? 'kb-status-negative-surface kb-status-negative'
                              : 'kb-surface-accent kb-text-accent'
                      }`}
                    >
                      {session.status}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      intent:{' '}
                      <span className="kb-text-primary">{session.goal_summary || 'n/a'}</span>
                    </div>
                    <div>
                      current step:{' '}
                      <span className="kb-text-primary">{session.active_step || 'n/a'}</span>
                    </div>
                    <div>
                      waiting for confirmation:{' '}
                      <span className="font-mono kb-text-primary">
                        {String(session.pending_confirmation)}
                      </span>
                    </div>
                    <div>
                      available actions:{' '}
                      <span className="font-mono kb-text-primary">
                        {session.candidate_target_count}
                      </span>
                    </div>
                    <div>
                      updated:{' '}
                      <span className="font-mono kb-text-primary">
                        {new Date(session.updated_at).toLocaleTimeString(chronosSpeechLocale())}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>

      {!hideSurfaceControl || panelVisible('control-model') ? (
        <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          {!hideSurfaceControl ? (
            <Panel
              id="surface-control"
              visible={panelVisible('surface-control')}
              title="Surface Control"
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {(() => {
                  const latestAction = getGlobalSurfaceControlAction(data.controlActions);
                  const retryAction = latestAction
                    ? getActionDefinition(
                        data.controlActionAvailability.globalSurface,
                        latestAction.operation
                      )
                    : null;
                  return latestAction ? (
                    <>
                      <div className="mr-2 flex items-center rounded-lg border kb-border-subtle kb-surface-raised px-3 py-1.5 text-[10px] kb-text-muted">
                        {mt('chronos_surfaces', 'surfaces')}
                        <span className="ml-2">{latestAction.operation}</span>
                        <span className="ml-2">
                          <ActionStatusBadge action={latestAction} />
                        </span>
                      </div>
                      {latestAction.event_id && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedGlobalSurfaceActionId((current) =>
                              current === latestAction.event_id
                                ? null
                                : latestAction.event_id || null
                            )
                          }
                          className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                        >
                          {expandedGlobalSurfaceActionId === latestAction.event_id
                            ? mt('chronos_hide_latest_action', 'hide latest action')
                            : mt('chronos_show_latest_action', 'show latest action')}
                        </button>
                      )}
                      {latestAction.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => runSurfaceControl(null, latestAction.operation)}
                          disabled={
                            !retryAction?.enabled ||
                            surfaceActionTarget === `all:${latestAction.operation}`
                          }
                          title={retryAction?.disabledReason}
                          className="rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {surfaceActionTarget === `all:${latestAction.operation}`
                            ? mt('chronos_retrying', 'retrying')
                            : mt('chronos_retry_latest_action', 'retry latest action')}
                        </button>
                      )}
                    </>
                  ) : null;
                })()}
                {data.controlActionAvailability.globalSurface.map((action) => (
                  <button
                    key={action.operation}
                    type="button"
                    onClick={() => runSurfaceControl(null, action.operation)}
                    disabled={!action.enabled || surfaceActionTarget === `all:${action.operation}`}
                    title={action.disabledReason}
                    className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {surfaceActionTarget === `all:${action.operation}` ? 'working' : action.label}
                  </button>
                ))}
                {getSharedDisabledReason(data.controlActionAvailability.globalSurface) && (
                  <div className="w-full text-[10px] kb-text-muted">
                    {getSharedDisabledReason(data.controlActionAvailability.globalSurface)}
                  </div>
                )}
              </div>
              {(() => {
                const latestAction = getGlobalSurfaceControlAction(data.controlActions);
                return latestAction?.event_id &&
                  expandedGlobalSurfaceActionId === latestAction.event_id ? (
                  <div className="mb-3">
                    <ActionDetailList
                      actionId={latestAction.event_id}
                      details={data.controlActionDetails}
                    />
                    <ActionGuidance
                      latestAction={latestAction}
                      availableActions={data.controlActionAvailability.globalSurface}
                    />
                  </div>
                ) : null;
              })()}
              <div className="space-y-3">
                {data.surfaces.length === 0 ? (
                  <div className="text-[11px] italic kb-status-warning">
                    {mt('chronos_no_managed_surfaces', 'No managed surfaces.')}
                  </div>
                ) : (
                  data.surfaces.map((surface) => {
                    const surfaceActions = getAvailableSurfaceActions(data, surface.id);
                    const safeSurfaceActions = getActionsByRisk(surfaceActions, 'safe');
                    const riskySurfaceActions = getActionsByRisk(surfaceActions, 'risky');
                    const safeDisabledReason = getSharedDisabledReason(safeSurfaceActions);
                    const riskyDisabledReason = getSharedDisabledReason(riskySurfaceActions);
                    return (
                      <div
                        id={toDomId('surface', surface.id)}
                        key={surface.id}
                        className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                      >
                        {(() => {
                          const latestAction = getLatestSurfaceControlAction(
                            data.controlActions,
                            surface.id
                          );
                          return latestAction ? (
                            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2">
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                {mt('chronos_last_control_action', 'last control action')}
                              </div>
                              <ActionStatusBadge action={latestAction} />
                            </div>
                          ) : null;
                        })()}
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                              {surface.id}
                            </div>
                            <div className="mt-1 text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                              {surface.kind} ·{' '}
                              {surface.startupMode || mt('chronos_background', 'background')} ·{' '}
                              {surface.running
                                ? mt('chronos_running', 'running')
                                : mt('chronos_stopped', 'stopped')}
                            </div>
                          </div>
                          <div
                            className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                              surface.health === 'healthy'
                                ? 'kb-status-positive-surface kb-status-positive'
                                : surface.health === 'unhealthy'
                                  ? 'kb-status-negative-surface kb-status-negative'
                                  : 'kb-status-warning-surface kb-status-warning'
                            }`}
                          >
                            {surface.health}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] kb-text-muted">
                          pid:{' '}
                          <span className="font-mono kb-text-secondary">{surface.pid ?? '-'}</span>
                          {surface.detail ? (
                            <>
                              {' '}
                              · {mt('chronos_detail', 'detail')}:{' '}
                              <span className="font-mono kb-text-secondary">{surface.detail}</span>
                            </>
                          ) : null}
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <div
                            className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${surfaceSummaryBadgeClass(surface.controlTone)}`}
                          >
                            {surface.controlSummary}
                          </div>
                          <div className="text-[10px] kb-text-muted">
                            {mt('chronos_control_summary', 'control summary')}
                          </div>
                          {surface.controlRequestedBy && (
                            <div className="text-[10px] kb-text-muted">
                              {mt('chronos_requested_by', 'requested by')}{' '}
                              <span className="font-mono kb-text-secondary">
                                {surface.controlRequestedBy}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(() => {
                            const latestAction = getLatestSurfaceControlAction(
                              data.controlActions,
                              surface.id
                            );
                            const retryAction = latestAction
                              ? getActionDefinition(surfaceActions, latestAction.operation)
                              : null;
                            if (!latestAction?.event_id) return null;
                            return (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedSurfaceCardActionId((current) =>
                                      current === latestAction.event_id
                                        ? null
                                        : latestAction.event_id || null
                                    )
                                  }
                                  className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                                >
                                  {expandedSurfaceCardActionId === latestAction.event_id
                                    ? mt('chronos_hide_latest_action', 'hide latest action')
                                    : mt('chronos_show_latest_action', 'show latest action')}
                                </button>
                                {latestAction.status === 'failed' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      runSurfaceControl(surface.id, latestAction.operation)
                                    }
                                    disabled={
                                      !retryAction?.enabled ||
                                      surfaceActionTarget ===
                                        `${surface.id}:${latestAction.operation}`
                                    }
                                    title={retryAction?.disabledReason}
                                    className="rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    {surfaceActionTarget ===
                                    `${surface.id}:${latestAction.operation}`
                                      ? mt('chronos_retrying', 'retrying')
                                      : mt('chronos_retry_latest_action', 'retry latest action')}
                                  </button>
                                )}
                              </>
                            );
                          })()}
                          <div className="flex flex-wrap gap-2 rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-2">
                            <div className="w-full text-[9px] uppercase tracking-[0.18em] kb-status-positive">
                              {mt('chronos_safe_actions', 'safe actions')}
                            </div>
                            {safeSurfaceActions.map((action) => (
                              <button
                                key={action.operation}
                                type="button"
                                onClick={() => runSurfaceControl(surface.id, action.operation)}
                                disabled={
                                  !action.enabled ||
                                  surfaceActionTarget === `${surface.id}:${action.operation}`
                                }
                                title={action.disabledReason}
                                className={actionButtonClass('safe')}
                              >
                                {surfaceActionTarget === `${surface.id}:${action.operation}`
                                  ? mt('chronos_working', 'working')
                                  : action.label}
                              </button>
                            ))}
                            {safeDisabledReason && (
                              <div className="w-full text-[10px] kb-text-muted">
                                {safeDisabledReason}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-2">
                            <div className="w-full text-[9px] uppercase tracking-[0.18em] kb-status-negative">
                              {mt(
                                'chronos_risky_actions_approval_required',
                                'risky actions · approval required'
                              )}
                            </div>
                            {riskySurfaceActions.map((action) => (
                              <button
                                key={action.operation}
                                type="button"
                                onClick={() => {
                                  const prompt = buildDangerousActionPrompt(
                                    `surface ${surface.id}`,
                                    action.label,
                                    false
                                  );
                                  requestDangerousAction(
                                    prompt.title,
                                    prompt.detail,
                                    prompt.confirmLabel,
                                    () => runSurfaceControl(surface.id, action.operation)
                                  );
                                }}
                                disabled={
                                  !action.enabled ||
                                  surfaceActionTarget === `${surface.id}:${action.operation}`
                                }
                                title={action.disabledReason}
                                className={actionButtonClass('risky')}
                              >
                                {surfaceActionTarget === `${surface.id}:${action.operation}`
                                  ? mt('chronos_working', 'working')
                                  : action.label}
                              </button>
                            ))}
                            {riskyDisabledReason && (
                              <div className="w-full text-[10px] kb-text-muted">
                                {riskyDisabledReason}
                              </div>
                            )}
                          </div>
                        </div>
                        {(() => {
                          const latestAction = getLatestSurfaceControlAction(
                            data.controlActions,
                            surface.id
                          );
                          return latestAction?.event_id &&
                            expandedSurfaceCardActionId === latestAction.event_id ? (
                            <>
                              <ActionDetailList
                                actionId={latestAction.event_id}
                                details={data.controlActionDetails}
                              />
                              <ActionGuidance
                                latestAction={latestAction}
                                availableActions={surfaceActions}
                              />
                            </>
                          ) : null;
                        })()}
                      </div>
                    );
                  })
                )}
              </div>
            </Panel>
          ) : null}

          <Panel
            id="control-model"
            visible={panelVisible('control-model')}
            title={mt('chronos_control_model', 'Control Model')}
          >
            <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] leading-6 kb-text-muted">
              {mt(
                'chronos_control_model_description',
                'Chronos is a control surface. It does not mutate mission or runtime state directly. Each button issues a deterministic backend action through mission_controller, agent-runtime-supervisor, or surface_runtime, then refreshes the control-plane view.'
              )}
            </div>
          </Panel>
        </section>
      ) : null}
    </>
  );
}
