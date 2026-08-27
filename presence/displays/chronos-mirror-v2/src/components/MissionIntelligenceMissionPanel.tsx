/* Mission control cards are kept separate from the data/effect controller. */
'use client';

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
  attentionActionLabel,
  attentionNextStepLabel,
  attentionReasonLabel,
  attentionSourceLabel,
  buildApprovalWorkLoopPreview,
  buildArtifactWorkLoopPreview,
  buildDangerousActionPrompt,
  buildDistillCandidateWorkLoopPreview,
  buildMissionSeedWorkLoopPreview,
  buildMissionThread,
  buildProjectWorkLoopPreview,
  getActionDefinition,
  getGlobalSurfaceControlAction,
  getLatestMissionControlAction,
  getLatestSurfaceControlAction,
  messageToneClass,
  messageTypeLabel,
  missionActionLabel,
  missionStatusLabel,
  missionSummaryBadgeClass,
  surfaceSummaryBadgeClass,
  toDomId,
} from './MissionIntelligenceViewHelpers';
import { Panel, providerResolutionSummary } from './MissionIntelligencePrimitives';
import { chronosSpeechLocale } from '../lib/ux-vocabulary';

export function MissionIntelligenceMissionPanel(context: Record<string, any>) {
  const {
    data,
    locale,
    mt,
    missionActionText,
    selectedProject,
    selectedProjectId,
    selectedProjectBootstrapItems,
    selectedTrackId,
    missionActionTarget,
    missionSeedTarget,
    trackSeedTarget,
    remediationTarget,
    outboxTarget,
    expandedMissionCardActionId,
    selectedReferencePath,
    referenceDetail,
    referenceMetadataEntries,
    referenceSections,
    selectedReferenceSeed,
    effectiveMissionId,
    learnedProjectRefs,
    learnedMissionSeedRefs,
    deliveryExceptions,
    filteredMissions,
    filteredServiceBindings,
    filteredMissionSeedsByTrack,
    hydratedTracks,
    missionProgress,
    runtime,
    runtimeLeases,
    runtimeDoctor,
    runtimeTopology,
    recentSurfaceOutbox,
    projectManagement,
    missionSeedAssessment,
    requestDangerousAction,
    clearOutboxMessage,
    createTrackSeed,
    focusMissionCard,
    focusMissionThread,
    openKnowledgeReference,
    openRuntimeReference,
    promoteMissionSeed,
    remediateLease,
    runMissionControl,
    setSelectedMissionId,
    setSelectedProjectId,
    setSelectedTrackId,
    setMessageMissionFilter,
    setExpandedMissionCardActionId,
    panelVisible,
    buildMissionIntentSummary,
  } = context;

  const getActionsByRisk = (actions: any[], risk: 'safe' | 'risky') =>
    actions.filter((action) => action.risk === risk);
  const getSharedDisabledReason = (actions: any[]) =>
    actions.map((action) => action.disabledReason).find((reason) => Boolean(reason)) || null;
  const getAvailableMissionActions = (payload: any, missionId: string) =>
    payload.controlActionAvailability.mission[missionId] || payload.controlActionCatalog.mission;
  const getAvailableSurfaceActions = (payload: any, surfaceId: string) =>
    payload.controlActionAvailability.surface[surfaceId] || payload.controlActionCatalog.surface;

  return (
    <section className="grid gap-4 lg:grid-cols-[1.25fr,1fr,1fr]">
      <Panel
        id="mission-control-plane"
        visible={panelVisible('mission-control-plane')}
        title={mt('chronos_mission_control', 'Mission control')}
      >
        <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
          {mt(
            'chronos_mission_control_description',
            'Confirm which durable work items are active, which ones are blocked, and what the next safe intervention is. Pinning a mission narrows the unified thread below without leaving the operator console.'
          )}
        </div>
        {selectedProject &&
        filteredMissions.length === 0 &&
        selectedProjectBootstrapItems.length > 0 ? (
          <div className="mb-4 rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[11px] leading-5 kb-text-accent">
            {mt(
              'chronos_project_bootstrap_notice',
              'This project does not have active missions yet. Current bootstrap work:'
            )}
            <div className="mt-2 text-[10px] kb-text-accent">
              {selectedProjectBootstrapItems
                .slice(0, 4)
                .map((item) => `${item.title} [${item.status}]`)
                .join(' -> ')}
            </div>
          </div>
        ) : null}
        <div className="space-y-3">
          {filteredMissions.length === 0 ? (
            <div className="text-[11px] italic kb-status-warning">No active missions.</div>
          ) : (
            filteredMissions.map((mission) => {
              const progress = data.missionProgress.find(
                (entry) => entry.missionId === mission.missionId
              );
              const latestAsset = progress?.generatedAssets?.[0];
              const missionIntent = buildMissionIntentSummary(data, mission);
              const missionActions = getAvailableMissionActions(data, mission.missionId);
              const safeMissionActions = getActionsByRisk(missionActions, 'safe');
              const riskyMissionActions = getActionsByRisk(missionActions, 'risky');
              const safeDisabledReason = getSharedDisabledReason(safeMissionActions);
              const riskyDisabledReason = getSharedDisabledReason(riskyMissionActions);
              return (
                <div
                  id={toDomId('mission', mission.missionId)}
                  key={mission.missionId}
                  className={`rounded-xl border kb-surface-sunken px-4 py-3 ${effectiveMissionId === mission.missionId ? 'kb-border-accent shadow-[0_0_0_1px_rgba(34,211,238,0.08)]' : 'kb-border-subtle'}`}
                >
                  {(() => {
                    const latestAction = getLatestMissionControlAction(
                      data.controlActions,
                      mission.missionId
                    );
                    return latestAction ? (
                      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          {mt('chronos_latest_intervention', 'Latest action')}
                        </div>
                        <ActionStatusBadge action={latestAction} />
                      </div>
                    ) : null;
                  })()}
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[12px] font-semibold tracking-[0.03em] kb-text-primary">
                        {missionIntent}
                      </div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                        {mission.missionType || 'development'} · {mission.tier} ·{' '}
                        {mission.missionId}
                      </div>
                      {mission.projectId || mission.trackId ? (
                        <div className="mt-1 text-[10px] kb-text-muted">
                          {mission.projectId
                            ? `${mt('chronos_project', 'Project')} ${mission.projectId}`
                            : null}
                          {mission.projectId && mission.trackId ? ' · ' : null}
                          {mission.trackId
                            ? `${mt('chronos_track', 'Track')} ${mission.trackName || mission.trackId}`
                            : null}
                        </div>
                      ) : null}
                    </div>
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                        mission.planReady
                          ? 'kb-status-positive-surface kb-status-positive'
                          : 'kb-status-warning-surface kb-status-warning'
                      }`}
                    >
                      {mission.planReady
                        ? mt('chronos_plan_ready', 'Plan ready')
                        : missionStatusLabel(mission.status, locale)}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${missionSummaryBadgeClass(mission.controlTone)}`}
                    >
                      {missionStatusLabel(mission.controlSummary, locale)}
                    </div>
                    <div className="text-[10px] kb-text-muted">
                      {mt('chronos_current_state', 'Current state')}
                    </div>
                    {mission.controlRequestedBy && (
                      <div className="text-[10px] kb-text-muted">
                        {mt('chronos_requested_by', 'Requested by')}{' '}
                        <span className="font-mono kb-text-secondary">
                          {mission.controlRequestedBy}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="mt-3 grid gap-2 text-[10px] kb-text-muted">
                    <div>
                      {mt('chronos_intent', 'Intent')}:{' '}
                      <span className="kb-text-primary">{missionIntent}</span>
                    </div>
                    <div>
                      {mt('chronos_plan', 'Plan')}:{' '}
                      <span className="kb-text-primary">
                        {mission.planReady
                          ? mt('chronos_plan_ready_to_continue', 'Ready to execute or continue')
                          : mt('chronos_plan_pending', 'Still being prepared')}
                      </span>
                    </div>
                    <div>
                      {mt('chronos_result', 'Result')}:{' '}
                      <span className="kb-text-primary">
                        {latestAsset
                          ? latestAsset.path.split('/').pop()
                          : mt('chronos_no_artifact_yet', 'No deliverable yet')}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      {mt('chronos_open_work', 'Open work')}:{' '}
                      <span className="font-mono kb-text-primary">{mission.nextTaskCount}</span>
                    </div>
                    <div>
                      {mt('chronos_plan', 'Plan')}:{' '}
                      <span className="font-mono kb-text-primary">
                        {mission.planReady
                          ? mt('chronos_ready', 'Ready')
                          : mt('chronos_pending', 'Pending')}
                      </span>
                    </div>
                    <div>
                      {mt('chronos_results', 'Results')}:{' '}
                      <span className="font-mono kb-text-primary">
                        {progress?.generatedAssets?.length ?? 0}
                      </span>
                    </div>
                    <div>
                      {mt('chronos_latest_deliverable', 'Latest deliverable')}:{' '}
                      <span className="font-mono kb-text-primary">
                        {latestAsset
                          ? latestAsset.path.split('/').pop()
                          : mt('chronos_none', 'None')}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => focusMissionThread(mission.missionId)}
                      className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                    >
                      <span className="inline-flex items-center gap-2">
                        <span>{mt('chronos_thread', 'Conversation')}</span>
                        <span className="rounded-full border kb-border-accent kb-surface-accent px-1.5 py-0.5 text-[8px] tracking-[0.18em] kb-text-accent">
                          T
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => focusMissionCard(mission.missionId)}
                      className="ml-2 rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
                    >
                      <span className="inline-flex items-center gap-2">
                        <span>{mt('chronos_card', 'Summary')}</span>
                        <span className="rounded-full border kb-border-subtle kb-surface-raised/8 px-1.5 py-0.5 text-[8px] tracking-[0.18em] kb-text-secondary">
                          C
                        </span>
                      </span>
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(() => {
                      const latestAction = getLatestMissionControlAction(
                        data.controlActions,
                        mission.missionId
                      );
                      const retryAction = latestAction
                        ? getActionDefinition(missionActions, latestAction.operation)
                        : null;
                      if (!latestAction?.event_id) return null;
                      return (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedMissionCardActionId((current) =>
                                current === latestAction.event_id
                                  ? null
                                  : latestAction.event_id || null
                              )
                            }
                            className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                          >
                            {expandedMissionCardActionId === latestAction.event_id
                              ? mt('chronos_hide_latest_action', 'Hide latest action')
                              : mt('chronos_show_latest_action', 'Show latest action')}
                          </button>
                          {latestAction.status === 'failed' && (
                            <button
                              type="button"
                              onClick={() =>
                                runMissionControl(mission.missionId, latestAction.operation)
                              }
                              disabled={
                                !retryAction?.enabled ||
                                missionActionTarget ===
                                  `${mission.missionId}:${latestAction.operation}`
                              }
                              title={retryAction?.disabledReason}
                              className="rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {missionActionTarget ===
                              `${mission.missionId}:${latestAction.operation}`
                                ? mt('chronos_retrying', 'Retrying')
                                : mt('chronos_retry_latest_action', 'Retry latest action')}
                            </button>
                          )}
                        </>
                      );
                    })()}
                    <div className="flex flex-wrap gap-2 rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-2">
                      <div className="w-full text-[9px] uppercase tracking-[0.18em] kb-status-positive">
                        {mt('chronos_safe_actions', 'Safe actions')}
                      </div>
                      {safeMissionActions.map((action) => (
                        <button
                          key={action.operation}
                          type="button"
                          onClick={() => runMissionControl(mission.missionId, action.operation)}
                          disabled={
                            !action.enabled ||
                            missionActionTarget === `${mission.missionId}:${action.operation}`
                          }
                          title={action.disabledReason}
                          className={actionButtonClass('safe')}
                        >
                          {missionActionTarget === `${mission.missionId}:${action.operation}`
                            ? mt('chronos_processing', 'Processing')
                            : missionActionText(action)}
                        </button>
                      ))}
                      {safeDisabledReason && (
                        <div className="w-full text-[10px] kb-text-muted">{safeDisabledReason}</div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-2">
                      <div className="w-full text-[9px] uppercase tracking-[0.18em] kb-status-negative">
                        {mt(
                          'chronos_risky_actions_approval_required',
                          'Risky actions · approval required'
                        )}
                      </div>
                      {riskyMissionActions.map((action) => (
                        <button
                          key={action.operation}
                          type="button"
                          onClick={() => {
                            const prompt = buildDangerousActionPrompt(
                              `mission ${mission.missionId}`,
                              action.label,
                              false
                            );
                            requestDangerousAction(
                              prompt.title,
                              prompt.detail,
                              prompt.confirmLabel,
                              () => runMissionControl(mission.missionId, action.operation)
                            );
                          }}
                          disabled={
                            !action.enabled ||
                            missionActionTarget === `${mission.missionId}:${action.operation}`
                          }
                          title={action.disabledReason}
                          className={actionButtonClass('risky')}
                        >
                          {missionActionTarget === `${mission.missionId}:${action.operation}`
                            ? mt('chronos_processing', 'Processing')
                            : missionActionText(action)}
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
                    const latestAction = getLatestMissionControlAction(
                      data.controlActions,
                      mission.missionId
                    );
                    return latestAction?.event_id &&
                      expandedMissionCardActionId === latestAction.event_id ? (
                      <>
                        <ActionDetailList
                          actionId={latestAction.event_id}
                          details={data.controlActionDetails}
                        />
                        <ActionGuidance
                          latestAction={latestAction}
                          availableActions={missionActions}
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

      <Panel
        id="runtime-topology-map"
        visible={panelVisible('runtime-topology-map')}
        title="Runtime Topology Map"
      >
        <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
          This map shows what the supervisor daemon is currently holding: who owns each runtime,
          which runtimes are active, and which agent-to-agent or owner-to-agent flows were seen
          recently.
        </div>
        <div className="grid gap-3">
          <div className="grid gap-3 lg:grid-cols-[0.9fr,1.1fr]">
            <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                owners
              </div>
              <div className="space-y-2">
                {data.runtimeTopology.owners.length === 0 ? (
                  <SurfaceStatusPanel
                    eyebrow="Owners"
                    title="No managed owners discovered"
                    detail="Owner records appear once runtimes are bound to a mission or surface."
                    tone="neutral"
                  />
                ) : (
                  data.runtimeTopology.owners.map((owner) => (
                    <div
                      key={`${owner.type}:${owner.id}`}
                      className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2"
                    >
                      <div className="text-[10px] font-mono kb-text-secondary">{owner.id}</div>
                      <div className="mt-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                        {owner.type} · runtimes {owner.runtimeCount}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {owner.runtimeIds.map((runtimeId) => (
                          <span
                            key={runtimeId}
                            className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[9px] font-mono kb-text-muted"
                          >
                            {runtimeId}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                managed runtimes
              </div>
              <div className="space-y-2">
                {data.runtimeTopology.runtimes.length === 0 ? (
                  <SurfaceStatusPanel
                    eyebrow="Managed runtimes"
                    title="No managed runtimes discovered"
                    detail="Runtime records appear after an agent or surface registers with the control plane."
                    tone="neutral"
                  />
                ) : (
                  data.runtimeTopology.runtimes.map((runtime) => (
                    <div
                      key={runtime.agentId}
                      className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2"
                    >
                      {(() => {
                        const resolution = providerResolutionSummary(runtime.metadata);
                        return (
                          <>
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[10px] font-mono kb-text-primary">
                                {runtime.agentId}
                              </div>
                              <div
                                className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em] ${
                                  runtime.status === 'ready'
                                    ? 'kb-status-positive-surface kb-status-positive'
                                    : runtime.status === 'busy'
                                      ? 'kb-status-warning-surface kb-status-warning'
                                      : runtime.status === 'error'
                                        ? 'kb-status-negative-surface kb-status-negative'
                                        : 'kb-surface-raised kb-text-secondary'
                                }`}
                              >
                                {runtime.status}
                              </div>
                            </div>
                            <div className="mt-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                              {runtime.provider}
                              {runtime.modelId ? `/${runtime.modelId}` : ''} · {runtime.ownerType}:
                              {runtime.ownerId}
                            </div>
                            {resolution ? (
                              <div className="mt-1 text-[9px] kb-text-muted">
                                preferred {resolution.preferred} · strategy {resolution.strategy}
                              </div>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-2 text-[9px] kb-text-muted">
                              {runtime.leaseKind && <span>lease {runtime.leaseKind}</span>}
                              {runtime.requestedBy && (
                                <span>requested by {runtime.requestedBy}</span>
                              )}
                              {typeof runtime.pid === 'number' && <span>pid {runtime.pid}</span>}
                              <span>activity {runtime.recentActivityCount}</span>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
              recent flow
            </div>
            <div className="space-y-2">
              {data.runtimeTopology.flows.length === 0 ? (
                <div className="text-[10px] kb-text-muted">
                  No recent A2A or agent-message flow observed.
                </div>
              ) : (
                data.runtimeTopology.flows.map((flow) => (
                  <div
                    key={flow.id}
                    className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] font-mono kb-text-primary">
                        {flow.from} → {flow.to}
                      </div>
                      <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                        {flow.kind}
                      </div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[9px] kb-text-muted">
                      <span>count {flow.count}</span>
                      {flow.channel && <span>channel {flow.channel}</span>}
                      {flow.thread && <span>thread {flow.thread}</span>}
                      <span>
                        {new Date(flow.latestAt).toLocaleTimeString(chronosSpeechLocale())}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        id="runtime-lease-doctor"
        visible={panelVisible('runtime-lease-doctor')}
        title="Runtime Governance"
      >
        <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
          Managed runtimes are part of operations, not a separate playground. Use this section to
          resolve stale leases, errored runtimes, and ownership drift without over-restarting
          healthy agents.
        </div>
        <div className="space-y-3">
          {data.runtimeDoctor.length === 0 ? (
            <div className="text-[11px] italic kb-status-positive">
              No stale or orphaned runtime leases detected.
            </div>
          ) : (
            data.runtimeDoctor.map((finding, index) => (
              <div
                key={`${finding.agentId}-${index}`}
                className={`rounded-xl border px-3 py-3 ${
                  finding.severity === 'critical'
                    ? 'kb-status-negative-border kb-status-negative-surface'
                    : 'kb-status-warning-border kb-status-warning-surface'
                }`}
              >
                <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.18em]">
                  <span
                    className={
                      finding.severity === 'critical' ? 'kb-status-negative' : 'kb-status-warning'
                    }
                  >
                    {finding.severity}
                  </span>
                  <span className="font-mono kb-text-muted">{finding.agentId}</span>
                </div>
                <div className="mt-2 text-[10px] kb-text-secondary">owner: {finding.ownerId}</div>
                <div className="mt-1 text-[10px] kb-text-muted">{finding.reason}</div>
                <button
                  type="button"
                  onClick={() => {
                    const prompt = buildDangerousActionPrompt(
                      finding.agentId,
                      finding.recommendedAction === 'restart_runtime'
                        ? 'restart runtime'
                        : 'stop runtime',
                      false
                    );
                    requestDangerousAction(prompt.title, prompt.detail, prompt.confirmLabel, () =>
                      remediateLease(
                        finding.agentId,
                        finding.recommendedAction === 'restart_runtime'
                          ? 'restart_runtime_lease'
                          : 'cleanup_runtime_lease'
                      )
                    );
                  }}
                  disabled={remediationTarget === finding.agentId}
                  className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {remediationTarget === finding.agentId
                    ? 'remediating'
                    : finding.recommendedAction === 'restart_runtime'
                      ? 'restart runtime'
                      : 'stop runtime'}
                </button>
              </div>
            ))
          )}

          <div className="border-t kb-border-subtle pt-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
              Managed Runtime Leases
            </div>
            <div className="space-y-2">
              {data.runtimeLeases.slice(0, 6).map((lease) => (
                <div
                  key={`${lease.agent_id}-${lease.owner_id}`}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2"
                >
                  <div className="text-[10px] font-mono kb-text-secondary">{lease.agent_id}</div>
                  <div className="mt-1 text-[10px] kb-text-muted">
                    {lease.owner_type}: {lease.owner_id}
                  </div>
                  {typeof lease.metadata?.team_role === 'string' && (
                    <div className="mt-1 text-[10px] kb-text-muted">
                      team_role: {lease.metadata.team_role}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        id="recent-surface-outbox"
        visible={panelVisible('recent-surface-outbox')}
        title="Delivery Exceptions"
      >
        <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
          Outbox items are operator-facing delivery residue. Resolve them here only when the
          autonomous path has already stalled or a human-visible queue needs cleanup.
        </div>
        <div className="space-y-3">
          {data.recentSurfaceOutbox.length === 0 ? (
            <div className="text-[11px] italic kb-status-warning">
              {mt(
                'chronos_no_recent_surface_outbox',
                'No pending or recent surface outbox messages.'
              )}
            </div>
          ) : (
            data.recentSurfaceOutbox.map((message) => (
              <div
                key={message.message_id}
                className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                    {message.surface} · {message.source} · {message.channel}
                  </div>
                  <div className="text-[9px] font-mono kb-text-muted">
                    {new Date(message.created_at).toLocaleString(chronosSpeechLocale())}
                  </div>
                </div>
                <div className="mt-2 text-[9px] uppercase tracking-[0.18em] kb-text-muted">
                  {mt('chronos_correlation', 'correlation')}: {message.correlation_id}
                </div>
                <div className="mt-2 text-[11px] kb-text-primary">{message.text}</div>
                <button
                  type="button"
                  onClick={() => {
                    const prompt = buildDangerousActionPrompt(
                      `${message.surface} outbox`,
                      'clear outbox',
                      false
                    );
                    requestDangerousAction(prompt.title, prompt.detail, prompt.confirmLabel, () =>
                      clearOutboxMessage(message.surface, message.message_id)
                    );
                  }}
                  disabled={outboxTarget === message.message_id}
                  className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {outboxTarget === message.message_id
                    ? mt('chronos_clearing', 'clearing')
                    : mt('chronos_clear_outbox', 'clear outbox')}
                </button>
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel
        id="projects"
        visible={panelVisible('projects')}
        title={mt('chronos_projects', 'Projects')}
      >
        <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
          {mt(
            'chronos_projects_description',
            'Projects hold the long-lived intent context. Use this panel to see which durable work, bindings, and results already have a parent container before creating new missions.'
          )}
        </div>
        <div className="space-y-3">
          {data.projects.length === 0 ? (
            <SurfaceStatusPanel
              eyebrow="Projects"
              title="No projects registered yet"
              detail="Create the first project to anchor durable intent, bindings, and bootstrap work."
              tone="warning"
            />
          ) : (
            data.projects.map((project) => (
              <div
                key={project.project_id}
                className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
              >
                {(() => {
                  const learnedRefs = learnedProjectRefs(project.project_id);
                  const workLoop = buildProjectWorkLoopPreview(project);
                  const management = (data.projectManagement || []).find(
                    (item) => item.project.project_id === project.project_id
                  );
                  return (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                            {project.name}
                          </div>
                          <div className="mt-1 text-[10px] kb-text-muted">
                            {project.project_id} · {project.tier}
                          </div>
                        </div>
                        <div
                          className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                            project.status === 'active'
                              ? 'kb-status-positive-surface kb-status-positive'
                              : project.status === 'draft'
                                ? 'kb-surface-accent kb-text-accent'
                                : 'kb-surface-raised kb-text-secondary'
                          }`}
                        >
                          {project.status}
                        </div>
                      </div>
                      <div className="mt-3 text-[10px] kb-text-secondary">{project.summary}</div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                        <div>
                          {mt('chronos_missions', 'missions')}:{' '}
                          <span className="font-mono kb-text-primary">
                            {project.active_missions?.length ?? 0}
                          </span>
                        </div>
                        <div>
                          {mt('chronos_bindings', 'bindings')}:{' '}
                          <span className="font-mono kb-text-primary">
                            {project.service_bindings?.length ?? 0}
                          </span>
                        </div>
                      </div>
                      {project.bootstrap_work_items?.length ? (
                        <div className="mt-3 text-[10px] kb-text-muted">
                          {mt('chronos_next_work', 'next work')}:{' '}
                          {project.bootstrap_work_items
                            .slice(0, 3)
                            .map((item) => item.title)
                            .join(' -> ')}
                        </div>
                      ) : null}
                      {project.kickoff_task_session_id ? (
                        <div className="mt-2 text-[10px] kb-text-muted">
                          {mt('chronos_kickoff', 'kickoff')}:{' '}
                          <span className="font-mono kb-text-secondary">
                            {project.kickoff_task_session_id}
                          </span>
                        </div>
                      ) : null}
                      {management ? (
                        <div className="mt-3 rounded-lg border kb-border-accent kb-surface-accent px-3 py-3 text-[10px] kb-text-muted">
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                            {mt('chronos_project_lineage', 'project lineage')}
                          </div>
                          <div className="mt-2 kb-text-primary">
                            {mt(
                              'chronos_project_hierarchy',
                              'Project → Track → Mission → Task / Task Session'
                            )}
                          </div>
                          <div className="mt-1">
                            {mt('chronos_lineage_counts', 'counts')}:{' '}
                            {management.lineage.tracks.length} {mt('chronos_tracks', 'tracks')} ·{' '}
                            {management.lineage.tasks.length} {mt('chronos_tasks', 'tasks')} ·{' '}
                            {management.lineage.missions.length}{' '}
                            {mt('chronos_missions', 'missions')} ·{' '}
                            {management.lineage.task_sessions.length}{' '}
                            {mt('chronos_task_sessions', 'task sessions')} ·{' '}
                            {management.lineage.pipelines.length}{' '}
                            {mt('chronos_pipelines', 'pipelines')}
                          </div>
                          <div className="mt-1">
                            {mt(
                              'chronos_pipeline_role',
                              'Pipeline is a replayable execution procedure, not a parent container.'
                            )}
                          </div>
                        </div>
                      ) : null}
                      <div className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-3 text-[10px] kb-text-muted">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          work loop
                        </div>
                        <div className="mt-2">
                          {mt('chronos_intent', 'intent')}:{' '}
                          <span className="kb-text-primary">{workLoop.intent}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_context', 'context')}:{' '}
                          <span className="kb-text-primary">{workLoop.context}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_resolution', 'resolution')}:{' '}
                          <span className="font-mono kb-text-primary">{workLoop.resolution}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_outcome', 'outcome')}:{' '}
                          <span className="kb-text-primary">{workLoop.outcome}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_team', 'team')}:{' '}
                          <span className="kb-text-primary">{workLoop.team}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_authority', 'authority')}:{' '}
                          <span className="kb-text-primary">{workLoop.authority}</span>
                        </div>
                      </div>
                      {learnedRefs.length ? (
                        <div className="mt-2 text-[10px] kb-text-muted">
                          {mt('chronos_learned', 'learned')}:{' '}
                          <span className="kb-text-secondary">
                            {learnedRefs.map((candidate) => candidate.title).join(', ')}
                          </span>
                        </div>
                      ) : null}
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedProjectId(project.project_id);
                            setSelectedMissionId(
                              (project.active_missions && project.active_missions[0]) || null
                            );
                            setMessageMissionFilter(
                              (project.active_missions && project.active_missions[0]) || 'all'
                            );
                          }}
                          className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                        >
                          {selectedProjectId === project.project_id
                            ? mt('chronos_focused', 'focused')
                            : mt('chronos_focus_project', 'focus project')}
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel id="tracks" visible={panelVisible('tracks')} title={mt('chronos_tracks', 'Tracks')}>
        <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
          {mt(
            'chronos_tracks_description',
            'Tracks are the SDLC and gating lanes inside a project. Focus a track to review evidence, approvals, and durable work without assuming one project equals one lifecycle.'
          )}
        </div>
        <div className="space-y-3">
          {hydratedTracks.length === 0 ? (
            <div className="text-[11px] italic kb-status-warning">
              {mt('chronos_no_tracks', 'No tracks registered yet.')}
            </div>
          ) : (
            hydratedTracks.map((track) => (
              <div
                key={track.track_id}
                className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                      {track.name}
                    </div>
                    <div className="mt-1 text-[10px] kb-text-muted">
                      {track.track_id} · {track.track_type} · {track.lifecycle_model}
                    </div>
                  </div>
                  <div className="rounded-full kb-surface-raised px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-secondary">
                    {track.status}
                  </div>
                </div>
                <div className="mt-3 text-[10px] kb-text-secondary">{track.summary}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                  <div>
                    {mt('chronos_project', 'project')}:{' '}
                    <span className="font-mono kb-text-primary">{track.project_id}</span>
                  </div>
                  <div>
                    {mt('chronos_required_artifacts', 'required artifacts')}:{' '}
                    <span className="font-mono kb-text-primary">
                      {track.required_artifacts?.length ?? 0}
                    </span>
                  </div>
                  {track.gate_readiness ? (
                    <>
                      <div>
                        {mt('chronos_gate_readiness', 'gate readiness')}:{' '}
                        <span className="font-mono kb-text-primary">
                          {track.gate_readiness.ready_gate_count}/
                          {track.gate_readiness.total_gate_count}
                        </span>
                      </div>
                      <div>
                        {mt('chronos_current_gate', 'current gate')}:{' '}
                        <span className="font-mono kb-text-primary">
                          {track.gate_readiness.current_gate_id ||
                            (track.gate_readiness.ready ? 'ready' : '-')}
                        </span>
                      </div>
                    </>
                  ) : null}
                </div>
                {track.gate_readiness?.next_required_artifacts?.length ? (
                  <div className="mt-2 text-[10px] kb-text-muted">
                    {mt('chronos_next_required', 'next required')}:{' '}
                    <span className="font-mono kb-text-secondary">
                      {track.gate_readiness.next_required_artifacts
                        .map((artifact) => artifact.artifact_id)
                        .join(', ')}
                    </span>
                  </div>
                ) : null}
                {track.release_id ? (
                  <div className="mt-2 text-[10px] kb-text-muted">
                    release: <span className="font-mono kb-text-secondary">{track.release_id}</span>
                  </div>
                ) : null}
                <div className="mt-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedTrackId(track.track_id)}
                      className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                    >
                      {selectedTrackId === track.track_id
                        ? mt('chronos_focused', 'focused')
                        : mt('chronos_focus_track', 'focus track')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        createTrackSeed(
                          track.track_id,
                          track.gate_readiness?.next_required_artifacts?.[0]?.artifact_id
                        )
                      }
                      disabled={
                        !track.gate_readiness?.next_required_artifacts?.length ||
                        trackSeedTarget === track.track_id
                      }
                      className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {trackSeedTarget === track.track_id
                        ? 'seeding'
                        : mt('chronos_seed_next_work', 'seed next work')}
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel
        id="service-bindings"
        visible={panelVisible('service-bindings')}
        title={mt('chronos_service_bindings', 'Service Bindings')}
      >
        <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
          {mt(
            'chronos_service_bindings_description',
            'Bindings define where Kyberion can read from or deliver to. This is the governed edge for GitHub, Slack, Drive, search, and other external systems.'
          )}
        </div>
        <div className="space-y-3">
          {filteredServiceBindings.length === 0 ? (
            <div className="text-[11px] italic kb-status-warning">
              No service bindings registered yet.
            </div>
          ) : (
            filteredServiceBindings.slice(0, 8).map((binding) => (
              <div
                key={binding.binding_id}
                className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                    {binding.binding_id}
                  </div>
                  <div className="rounded-full kb-surface-raised px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-secondary">
                    {binding.auth_mode || 'none'}
                  </div>
                </div>
                <div className="mt-2 text-[10px] kb-text-muted">
                  {binding.service_type} · {binding.scope} · {binding.target}
                </div>
                <div className="mt-2 text-[10px] kb-text-muted">
                  actions:{' '}
                  <span className="kb-text-secondary">
                    {binding.allowed_actions.slice(0, 4).join(', ') || 'none'}
                  </span>
                  {binding.allowed_actions.length > 4 ? (
                    <span className="kb-text-muted"> +{binding.allowed_actions.length - 4}</span>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel id="mission-seeds" visible={panelVisible('mission-seeds')} title="Mission Seeds">
        <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
          Proposed durable work can stay here before it becomes a full mission. Use this panel to
          confirm bootstrap output is structured and attributable.
        </div>
        <div className="mb-4 rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[10px] leading-5 kb-text-accent">
          assessment: eligible{' '}
          <span className="font-mono kb-text-accent">
            {data.missionSeedAssessment?.eligible ?? 0}
          </span>
          {' · '}
          flagged{' '}
          <span className="font-mono kb-text-accent">
            {data.missionSeedAssessment?.flagged ?? 0}
          </span>
          {' · '}
          unassessed{' '}
          <span className="font-mono kb-text-accent">
            {data.missionSeedAssessment?.unassessed ?? 0}
          </span>
          {' · '}
          promotable{' '}
          <span className="font-mono kb-text-accent">
            {data.missionSeedAssessment?.promotable ?? 0}
          </span>
        </div>
        <div className="space-y-3">
          {filteredMissionSeedsByTrack.length === 0 ? (
            <div className="text-[11px] italic kb-status-warning">
              No mission seeds recorded yet.
            </div>
          ) : (
            filteredMissionSeedsByTrack.slice(0, 8).map((seed) => (
              <div
                key={seed.seed_id}
                className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
              >
                {(() => {
                  const learnedRefs = learnedMissionSeedRefs(
                    seed.seed_id,
                    seed.project_id,
                    seed.promoted_mission_id
                  );
                  const workLoop = buildMissionSeedWorkLoopPreview(seed);
                  return (
                    <>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                          {seed.title}
                        </div>
                        <div className="rounded-full kb-surface-raised px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-secondary">
                          {seed.status}
                        </div>
                      </div>
                      <div className="mt-2 text-[10px] kb-text-secondary">{seed.summary}</div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                        <div>
                          project:{' '}
                          <span className="font-mono kb-text-primary">{seed.project_id}</span>
                        </div>
                        <div>
                          specialist:{' '}
                          <span className="font-mono kb-text-primary">{seed.specialist_id}</span>
                        </div>
                        <div>
                          work:{' '}
                          <span className="font-mono kb-text-primary">
                            {seed.source_work_id || '-'}
                          </span>
                        </div>
                        <div>
                          type:{' '}
                          <span className="font-mono kb-text-primary">
                            {seed.mission_type_hint || '-'}
                          </span>
                        </div>
                      </div>
                      {typeof seed.metadata?.template_ref === 'string' ? (
                        <div className="mt-2 text-[10px] kb-text-muted">
                          template:{' '}
                          <button
                            type="button"
                            onClick={() =>
                              openKnowledgeReference(seed.metadata?.template_ref as string)
                            }
                            className="font-mono kb-text-accent transition hover:kb-text-accent"
                          >
                            {seed.metadata.template_ref}
                          </button>
                        </div>
                      ) : null}
                      {typeof seed.metadata?.skeleton_path === 'string' ? (
                        <div className="mt-1 text-[10px] kb-text-muted">
                          skeleton:{' '}
                          <button
                            type="button"
                            onClick={() =>
                              openRuntimeReference(seed.metadata?.skeleton_path as string)
                            }
                            className="font-mono kb-text-accent transition hover:kb-text-accent"
                          >
                            {seed.metadata.skeleton_path}
                          </button>
                        </div>
                      ) : null}
                      {seed.promoted_mission_id ? (
                        <div className="mt-2 text-[10px] kb-text-muted">
                          mission:{' '}
                          <span className="font-mono kb-text-secondary">
                            {seed.promoted_mission_id}
                          </span>
                        </div>
                      ) : null}
                      <div className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-3 text-[10px] kb-text-muted">
                        <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                          work loop
                        </div>
                        <div className="mt-2">
                          {mt('chronos_intent', 'intent')}:{' '}
                          <span className="kb-text-primary">{workLoop.intent}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_context', 'context')}:{' '}
                          <span className="kb-text-primary">{workLoop.context}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_resolution', 'resolution')}:{' '}
                          <span className="font-mono kb-text-primary">{workLoop.resolution}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_outcome', 'outcome')}:{' '}
                          <span className="kb-text-primary">{workLoop.outcome}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_team', 'team')}:{' '}
                          <span className="kb-text-primary">{workLoop.team}</span>
                        </div>
                        <div className="mt-1">
                          {mt('chronos_authority', 'authority')}:{' '}
                          <span className="kb-text-primary">{workLoop.authority}</span>
                        </div>
                      </div>
                      {learnedRefs.length ? (
                        <div className="mt-2 text-[10px] kb-text-muted">
                          {mt('chronos_learned', 'learned')}:{' '}
                          <span className="kb-text-secondary">
                            {learnedRefs.map((candidate) => candidate.title).join(', ')}
                          </span>
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const prompt = buildDangerousActionPrompt(
                              `seed ${seed.seed_id}`,
                              'promote to mission',
                              false
                            );
                            requestDangerousAction(
                              prompt.title,
                              prompt.detail,
                              prompt.confirmLabel,
                              () => promoteMissionSeed(seed.seed_id)
                            );
                          }}
                          disabled={
                            seed.status === 'promoted' || missionSeedTarget === seed.seed_id
                          }
                          className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {missionSeedTarget === seed.seed_id
                            ? 'promoting'
                            : seed.status === 'promoted'
                              ? 'promoted'
                              : 'promote to mission'}
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            ))
          )}
        </div>
      </Panel>

      <Panel
        id="skeleton-detail"
        visible={panelVisible('skeleton-detail')}
        title={mt('chronos_skeleton_detail', 'Skeleton Detail')}
      >
        {!selectedReferencePath || !referenceDetail ? (
          <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_skeleton_detail_empty',
              'Select a track-generated skeleton to inspect its title, metadata, overview, and sections without leaving Chronos.'
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                  {referenceDetail.title || 'reference'}
                </div>
                <div className="font-mono text-[10px] kb-text-muted">
                  {selectedReferencePath.split('/').slice(-2).join('/')}
                </div>
              </div>
              <div className="mt-2 text-[10px] kb-text-secondary">
                {referenceDetail.summary || mt('chronos_no_summary', 'No summary available yet.')}
              </div>
              <div className="mt-2 text-[10px] kb-text-muted">
                path: <span className="font-mono kb-text-secondary">{selectedReferencePath}</span>
              </div>
              <div className="mt-2 text-[10px]">
                <a
                  className="kb-text-accent transition hover:kb-text-accent"
                  href={`${referenceDetail.endpoint}?path=${encodeURIComponent(selectedReferencePath)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {referenceDetail.openLabel ||
                    mt('chronos_open_raw_skeleton', 'open raw skeleton')}
                </a>
              </div>
              {selectedReferenceSeed ? (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      seed:{' '}
                      <span className="font-mono kb-text-secondary">
                        {selectedReferenceSeed.seed_id}
                      </span>
                    </div>
                    <div>
                      track:{' '}
                      <span className="font-mono kb-text-secondary">
                        {selectedReferenceSeed.track_name || selectedReferenceSeed.track_id || '-'}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedReferenceSeed.track_id ? (
                      <button
                        type="button"
                        onClick={() => setSelectedTrackId(selectedReferenceSeed.track_id || null)}
                        className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                      >
                        {mt('chronos_focus_track', 'focus track')}
                      </button>
                    ) : null}
                    {typeof selectedReferenceSeed.metadata?.template_ref === 'string' &&
                    selectedReferenceSeed.metadata.template_ref !== selectedReferencePath ? (
                      <button
                        type="button"
                        onClick={() =>
                          openKnowledgeReference(
                            selectedReferenceSeed.metadata?.template_ref as string
                          )
                        }
                        className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent"
                      >
                        {mt('chronos_open_template', 'open template')}
                      </button>
                    ) : null}
                    {typeof selectedReferenceSeed.metadata?.skeleton_path === 'string' &&
                    selectedReferenceSeed.metadata.skeleton_path !== selectedReferencePath ? (
                      <button
                        type="button"
                        onClick={() =>
                          openRuntimeReference(
                            selectedReferenceSeed.metadata?.skeleton_path as string
                          )
                        }
                        className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent"
                      >
                        {mt('chronos_open_skeleton', 'open skeleton')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        const prompt = buildDangerousActionPrompt(
                          `seed ${selectedReferenceSeed.seed_id}`,
                          'promote to mission',
                          false
                        );
                        requestDangerousAction(
                          prompt.title,
                          prompt.detail,
                          prompt.confirmLabel,
                          () => promoteMissionSeed(selectedReferenceSeed.seed_id)
                        );
                      }}
                      disabled={
                        selectedReferenceSeed.status === 'promoted' ||
                        missionSeedTarget === selectedReferenceSeed.seed_id
                      }
                      className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {missionSeedTarget === selectedReferenceSeed.seed_id
                        ? mt('chronos_processing', 'processing')
                        : selectedReferenceSeed.status === 'promoted'
                          ? mt('chronos_promoted', 'promoted')
                          : mt('chronos_promote_to_mission', 'promote to mission')}
                    </button>
                  </div>
                </>
              ) : null}
            </div>

            {referenceMetadataEntries.length ? (
              <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                  {mt('chronos_metadata', 'Metadata')}
                </div>
                <div className="mt-2 space-y-1">
                  {referenceMetadataEntries.map(([key, value]) => (
                    <div key={key} className="text-[10px] kb-text-muted">
                      <span className="font-mono kb-text-secondary">{key}</span>: {String(value)}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {referenceDetail.body ? (
              <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                  {mt('chronos_overview', 'Overview')}
                </div>
                <div className="mt-2 space-y-1">
                  {referenceDetail.body
                    .split('\n')
                    .filter((line) => line.trim())
                    .slice(0, 8)
                    .map((line, index) => (
                      <div key={`${line}-${index}`} className="text-[10px] kb-text-muted">
                        {line}
                      </div>
                    ))}
                </div>
              </div>
            ) : null}

            {referenceSections.map((section) => (
              <div
                key={section.title}
                className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
              >
                <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                  {section.title || 'Section'}
                </div>
                <div className="mt-2 space-y-1">
                  {section.lines
                    .filter((line) => line.trim())
                    .slice(0, 12)
                    .map((line, index) => (
                      <div key={`${section.title}-${index}`} className="text-[10px] kb-text-muted">
                        {line}
                      </div>
                    ))}
                  {!section.lines.some((line) => line.trim()) ? (
                    <div className="text-[10px] kb-text-muted">
                      {mt('chronos_no_detail', 'No detail.')}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}
