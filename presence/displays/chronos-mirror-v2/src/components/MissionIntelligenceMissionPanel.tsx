/* Mission control cards are kept separate from the data/effect controller. */
'use client';

import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Disclosure,
  EmptyState,
  Grid,
  KeyValue,
  Metric,
  StatusPill,
} from '@agent/shared-ui';
import {
  ActionDetailList,
  ActionGuidance,
  ActionStatusBadge,
  buildDangerousActionPrompt,
  buildMissionSeedWorkLoopPreview,
  buildProjectWorkLoopPreview,
  getActionDefinition,
  getLatestMissionControlAction,
  missionStatusLabel,
  missionToneStatus,
  toDomId,
  toKbStatus,
} from './MissionIntelligenceViewHelpers';
import { Panel, providerResolutionSummary } from './MissionIntelligencePrimitives';
import type { WorkLoopPreview } from './MissionIntelligenceTypes';
import { chronosSpeechLocale } from '../lib/ux-vocabulary';

type Mt = (key: string, fallback: string) => string;

/** Title + mono id, the shared "human name first, id secondary" cell. */
function NameWithId({ title, id }: { title: ReactNode; id?: string }) {
  return (
    <div className="chronos-mission-cell">
      <span className="kb-list__title">{title}</span>
      {id ? <span className="chronos-mission-cell__id">{id}</span> : null}
    </div>
  );
}

/** A labelled group of buttons (no coloured box — the label carries the meaning). */
function ActionGroup({
  label,
  note,
  children,
}: {
  label: string;
  note?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="kb-text kb-text--caption">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
      {note ? <span className="kb-text kb-text--caption">{note}</span> : null}
    </div>
  );
}

function WorkLoopDetail({ workLoop, mt }: { workLoop: WorkLoopPreview; mt: Mt }) {
  return (
    <Disclosure summary={mt('chronos_mi_work_loop', 'Work loop')}>
      <KeyValue
        items={[
          { label: mt('chronos_intent', 'intent'), value: workLoop.intent },
          { label: mt('chronos_context', 'context'), value: workLoop.context },
          { label: mt('chronos_resolution', 'resolution'), value: workLoop.resolution, mono: true },
          { label: mt('chronos_outcome', 'outcome'), value: workLoop.outcome },
          { label: mt('chronos_team', 'team'), value: workLoop.team },
          { label: mt('chronos_authority', 'authority'), value: workLoop.authority },
        ]}
      />
    </Disclosure>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="kb-text kb-text--muted">{children}</p>;
}

export function MissionIntelligenceMissionPanel({ context }: { context: Record<string, any> }) {
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
    filteredMissions,
    filteredServiceBindings,
    filteredMissionSeedsByTrack,
    hydratedTracks,
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
  const promoteSeed = (seed: any) => {
    const prompt = buildDangerousActionPrompt(`seed ${seed.seed_id}`, 'promote to mission', false);
    requestDangerousAction(prompt.title, prompt.detail, prompt.confirmLabel, () =>
      promoteMissionSeed(seed.seed_id)
    );
  };
  const seedPromoteLabel = (seed: any) =>
    missionSeedTarget === seed.seed_id
      ? mt('chronos_processing', 'processing')
      : seed.status === 'promoted'
        ? mt('chronos_promoted', 'promoted')
        : mt('chronos_promote_to_mission', 'promote to mission');

  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <Panel
        id="mission-control-plane"
        className="xl:col-span-2"
        visible={panelVisible('mission-control-plane')}
        title={mt('chronos_mission_control', 'Mission control')}
        description={mt(
          'chronos_mission_control_description',
          'Confirm which durable work items are active, which ones are blocked, and what the next safe intervention is. Pinning a mission narrows the unified thread below without leaving the operator console.'
        )}
      >
        {selectedProject &&
        filteredMissions.length === 0 &&
        selectedProjectBootstrapItems.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Muted>
              {mt(
                'chronos_project_bootstrap_notice',
                'This project does not have active missions yet. Current bootstrap work:'
              )}
            </Muted>
            <ul className="kb-list" data-variant="timeline">
              {selectedProjectBootstrapItems.slice(0, 4).map((item: any, index: number) => (
                <li
                  key={`${item.title}-${index}`}
                  className="kb-list__item"
                  data-status={toKbStatus(item.status)}
                >
                  <div className="kb-list__body">
                    <span className="kb-list__title">{item.title}</span>
                  </div>
                  <StatusPill status={toKbStatus(item.status)} label={item.status} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {filteredMissions.length === 0 ? (
          <EmptyState
            title={mt('chronos_mi_no_active_missions', 'No active missions.')}
            body={mt(
              'chronos_mi_no_active_missions_detail',
              'Plan a mission above, or open a mission candidate once one is ready.'
            )}
          />
        ) : (
          <ul className="kb-list">
            {filteredMissions.map((mission: any) => {
              const progress = data.missionProgress.find(
                (entry: any) => entry.missionId === mission.missionId
              );
              const latestAsset = progress?.generatedAssets?.[0];
              const latestAssetName = latestAsset ? latestAsset.path.split('/').pop() : null;
              const missionIntent = buildMissionIntentSummary(data, mission);
              const missionActions = getAvailableMissionActions(data, mission.missionId);
              const safeMissionActions = getActionsByRisk(missionActions, 'safe');
              const riskyMissionActions = getActionsByRisk(missionActions, 'risky');
              const safeDisabledReason = getSharedDisabledReason(safeMissionActions);
              const riskyDisabledReason = getSharedDisabledReason(riskyMissionActions);
              const latestAction = getLatestMissionControlAction(
                data.controlActions,
                mission.missionId
              );
              const retryAction = latestAction
                ? getActionDefinition(missionActions, latestAction.operation)
                : null;
              const isSelected = effectiveMissionId === mission.missionId;
              const busy = (operation: string) =>
                missionActionTarget === `${mission.missionId}:${operation}`;
              const meta = [
                mission.missionType || 'development',
                mission.tier,
                mission.projectId ? `${mt('chronos_project', 'Project')} ${mission.projectId}` : '',
                mission.trackId
                  ? `${mt('chronos_track', 'Track')} ${mission.trackName || mission.trackId}`
                  : '',
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li
                  id={toDomId('mission', mission.missionId)}
                  key={mission.missionId}
                  className="kb-list__item"
                  aria-current={isSelected ? 'true' : undefined}
                >
                  <div className="kb-list__body flex flex-col gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <NameWithId title={missionIntent} id={mission.missionId} />
                      <div className="flex flex-wrap items-center gap-2">
                        {isSelected ? (
                          <Badge
                            label={mt('chronos_mission_selected', 'Mission selected')}
                            tone="accent"
                          />
                        ) : null}
                        <StatusPill
                          status={
                            mission.planReady ? 'ready' : toKbStatus(mission.status, 'pending')
                          }
                          label={
                            mission.planReady
                              ? mt('chronos_plan_ready', 'Plan ready')
                              : missionStatusLabel(mission.status, locale)
                          }
                        />
                        <StatusPill
                          status={missionToneStatus(mission.controlTone)}
                          label={missionStatusLabel(mission.controlSummary, locale)}
                        />
                      </div>
                    </div>
                    <span className="kb-list__meta">{meta}</span>
                    <KeyValue
                      items={[
                        {
                          label: mt('chronos_plan', 'Plan'),
                          value: mission.planReady
                            ? mt('chronos_plan_ready_to_continue', 'Ready to execute or continue')
                            : mt('chronos_plan_pending', 'Still being prepared'),
                        },
                        {
                          label: mt('chronos_open_work', 'Open work'),
                          value: mission.nextTaskCount,
                        },
                        {
                          label: mt('chronos_results', 'Results'),
                          value: progress?.generatedAssets?.length ?? 0,
                        },
                        {
                          label: mt('chronos_latest_deliverable', 'Latest deliverable'),
                          value:
                            latestAssetName || mt('chronos_no_artifact_yet', 'No deliverable yet'),
                          mono: Boolean(latestAssetName),
                        },
                        ...(mission.controlRequestedBy
                          ? [
                              {
                                label: mt('chronos_requested_by', 'Requested by'),
                                value: mission.controlRequestedBy,
                                mono: true,
                              },
                            ]
                          : []),
                      ]}
                    />
                    {latestAction ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="kb-text kb-text--caption">
                          {mt('chronos_latest_intervention', 'Latest action')}
                        </span>
                        <ActionStatusBadge action={latestAction} />
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="primary"
                        label={mt('chronos_mi_conversation', 'Conversation')}
                        onClick={() => focusMissionThread(mission.missionId)}
                      />
                      <Button
                        label={mt('chronos_card', 'Summary')}
                        onClick={() => focusMissionCard(mission.missionId)}
                      />
                      {latestAction?.event_id ? (
                        <Button
                          variant="ghost"
                          label={
                            expandedMissionCardActionId === latestAction.event_id
                              ? mt('chronos_hide_latest_action', 'Hide latest action')
                              : mt('chronos_show_latest_action', 'Show latest action')
                          }
                          onClick={() =>
                            setExpandedMissionCardActionId((current: string | null) =>
                              current === latestAction.event_id
                                ? null
                                : latestAction.event_id || null
                            )
                          }
                        />
                      ) : null}
                      {latestAction?.event_id && latestAction.status === 'failed' ? (
                        <Button
                          variant="danger"
                          disabled={!retryAction?.enabled || busy(latestAction.operation)}
                          label={
                            busy(latestAction.operation)
                              ? mt('chronos_retrying', 'Retrying')
                              : mt('chronos_retry_latest_action', 'Retry latest action')
                          }
                          onClick={() =>
                            runMissionControl(mission.missionId, latestAction.operation)
                          }
                        />
                      ) : null}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <ActionGroup
                        label={mt('chronos_safe_actions', 'Safe actions')}
                        note={safeDisabledReason}
                      >
                        {safeMissionActions.map((action: any) => (
                          <Button
                            key={action.operation}
                            disabled={!action.enabled || busy(action.operation)}
                            label={
                              busy(action.operation)
                                ? mt('chronos_processing', 'Processing')
                                : missionActionText(action)
                            }
                            onClick={() => runMissionControl(mission.missionId, action.operation)}
                          />
                        ))}
                      </ActionGroup>
                      <ActionGroup
                        label={mt(
                          'chronos_risky_actions_approval_required',
                          'Risky actions · approval required'
                        )}
                        note={riskyDisabledReason}
                      >
                        {riskyMissionActions.map((action: any) => (
                          <Button
                            key={action.operation}
                            variant="danger"
                            disabled={!action.enabled || busy(action.operation)}
                            label={
                              busy(action.operation)
                                ? mt('chronos_processing', 'Processing')
                                : missionActionText(action)
                            }
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
                          />
                        ))}
                      </ActionGroup>
                    </div>
                    {latestAction?.event_id &&
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
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        id="runtime-topology-map"
        className="xl:col-span-2"
        visible={panelVisible('runtime-topology-map')}
        title={mt('chronos_mi_runtime_topology', 'Runtime Topology Map')}
        description={mt(
          'chronos_mi_runtime_topology_detail',
          'What the supervisor daemon is currently holding: who owns each runtime, which runtimes are active, and which agent-to-agent or owner-to-agent flows were seen recently.'
        )}
      >
        <div className="chronos-two-col">
          <div className="chronos-feed">
            <h4 className="chronos-feed__title">{mt('chronos_mi_owners', 'Owners')}</h4>
            {data.runtimeTopology.owners.length === 0 ? (
              <Muted>
                {mt(
                  'chronos_mi_no_owners',
                  'No managed owners yet. Owner records appear once runtimes are bound to a mission or surface.'
                )}
              </Muted>
            ) : (
              <ul className="kb-list">
                {data.runtimeTopology.owners.map((owner: any) => (
                  <li key={`${owner.type}:${owner.id}`} className="kb-list__item">
                    <div className="kb-list__body">
                      <NameWithId title={owner.type} id={owner.id} />
                      <span className="kb-list__meta">
                        {mt('chronos_mi_runtimes', 'runtimes')} {owner.runtimeCount} ·{' '}
                        <span className="chronos-mission-cell__id">
                          {owner.runtimeIds.join(', ')}
                        </span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="chronos-feed">
            <h4 className="chronos-feed__title">
              {mt('chronos_mi_managed_runtimes', 'Managed runtimes')}
            </h4>
            {data.runtimeTopology.runtimes.length === 0 ? (
              <Muted>
                {mt(
                  'chronos_mi_no_runtimes',
                  'No managed runtimes yet. Runtime records appear after an agent or surface registers with the control plane.'
                )}
              </Muted>
            ) : (
              <ul className="kb-list">
                {data.runtimeTopology.runtimes.map((runtime: any) => {
                  const resolution = providerResolutionSummary(runtime.metadata);
                  const facts = [
                    `${runtime.provider}${runtime.modelId ? `/${runtime.modelId}` : ''}`,
                    `${runtime.ownerType}:${runtime.ownerId}`,
                    resolution ? `${resolution.preferred} (${resolution.strategy})` : '',
                    runtime.leaseKind ? `lease ${runtime.leaseKind}` : '',
                    runtime.requestedBy
                      ? `${mt('chronos_requested_by', 'Requested by')} ${runtime.requestedBy}`
                      : '',
                    typeof runtime.pid === 'number' ? `pid ${runtime.pid}` : '',
                    `${mt('chronos_mi_activity', 'activity')} ${runtime.recentActivityCount}`,
                  ].filter(Boolean);
                  return (
                    <li key={runtime.agentId} className="kb-list__item">
                      <div className="kb-list__body">
                        <span className="kb-list__title chronos-mission-cell__id">
                          {runtime.agentId}
                        </span>
                        <span className="kb-list__meta">{facts.join(' · ')}</span>
                      </div>
                      <StatusPill status={toKbStatus(runtime.status)} label={runtime.status} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <div className="chronos-feed">
          <h4 className="chronos-feed__title">{mt('chronos_mi_recent_flow', 'Recent flow')}</h4>
          {data.runtimeTopology.flows.length === 0 ? (
            <Muted>
              {mt('chronos_mi_no_recent_flow', 'No recent A2A or agent-message flow observed.')}
            </Muted>
          ) : (
            <ul className="kb-list" data-variant="timeline">
              {data.runtimeTopology.flows.map((flow: any) => (
                <li key={flow.id} className="kb-list__item">
                  <div className="kb-list__body">
                    <span className="kb-list__title chronos-mission-cell__id">
                      {flow.from} → {flow.to}
                    </span>
                    <span className="kb-list__meta">
                      {[
                        flow.kind,
                        `× ${flow.count}`,
                        flow.channel ? `#${flow.channel}` : '',
                        flow.thread ? `thread ${flow.thread}` : '',
                        new Date(flow.latestAt).toLocaleTimeString(chronosSpeechLocale()),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel
        id="runtime-lease-doctor"
        visible={panelVisible('runtime-lease-doctor')}
        title={mt('chronos_mi_runtime_governance', 'Runtime Governance')}
        description={mt(
          'chronos_mi_runtime_governance_detail',
          'Managed runtimes are part of operations. Resolve stale leases, errored runtimes, and ownership drift here without over-restarting healthy agents.'
        )}
      >
        {data.runtimeDoctor.length === 0 ? (
          <Muted>
            {mt('chronos_mi_no_lease_findings', 'No stale or orphaned runtime leases detected.')}
          </Muted>
        ) : (
          <ul className="kb-list">
            {data.runtimeDoctor.map((finding: any, index: number) => {
              const restart = finding.recommendedAction === 'restart_runtime';
              const actionLabel = restart
                ? mt('chronos_restart_runtime', 'restart runtime')
                : mt('chronos_mi_stop_runtime', 'stop runtime');
              return (
                <li key={`${finding.agentId}-${index}`} className="kb-list__item">
                  <div className="kb-list__body">
                    <NameWithId title={finding.reason} id={finding.agentId} />
                    <span className="kb-list__meta">
                      {mt('chronos_mi_owner', 'owner')} {finding.ownerId}
                    </span>
                    <div className="pt-1">
                      <Button
                        variant="danger"
                        disabled={remediationTarget === finding.agentId}
                        label={
                          remediationTarget === finding.agentId
                            ? mt('chronos_processing', 'processing')
                            : actionLabel
                        }
                        onClick={() => {
                          const prompt = buildDangerousActionPrompt(
                            finding.agentId,
                            restart ? 'restart runtime' : 'stop runtime',
                            false
                          );
                          requestDangerousAction(
                            prompt.title,
                            prompt.detail,
                            prompt.confirmLabel,
                            () =>
                              remediateLease(
                                finding.agentId,
                                restart ? 'restart_runtime_lease' : 'cleanup_runtime_lease'
                              )
                          );
                        }}
                      />
                    </div>
                  </div>
                  <StatusPill
                    status={finding.severity === 'critical' ? 'blocked' : 'degraded'}
                    label={finding.severity}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {data.runtimeLeases.length > 0 ? (
          <Disclosure
            summary={`${mt('chronos_mi_managed_leases', 'Managed runtime leases')} (${data.runtimeLeases.length})`}
          >
            <ul className="kb-list">
              {data.runtimeLeases.slice(0, 6).map((lease: any) => (
                <li key={`${lease.agent_id}-${lease.owner_id}`} className="kb-list__item">
                  <div className="kb-list__body">
                    <span className="kb-list__title chronos-mission-cell__id">
                      {lease.agent_id}
                    </span>
                    <span className="kb-list__meta">
                      {lease.owner_type}: {lease.owner_id}
                      {typeof lease.metadata?.team_role === 'string'
                        ? ` · ${lease.metadata.team_role}`
                        : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </Panel>

      <Panel
        id="recent-surface-outbox"
        visible={panelVisible('recent-surface-outbox')}
        title={mt('chronos_mi_delivery_exceptions', 'Delivery Exceptions')}
        description={mt(
          'chronos_mi_delivery_exceptions_detail',
          'Outbox items are operator-facing delivery residue. Clear them only when the autonomous path has stalled or a human-visible queue needs cleanup.'
        )}
      >
        {data.recentSurfaceOutbox.length === 0 ? (
          <Muted>
            {mt(
              'chronos_no_recent_surface_outbox',
              'No pending or recent surface outbox messages.'
            )}
          </Muted>
        ) : (
          <ul className="kb-list">
            {data.recentSurfaceOutbox.map((message: any) => (
              <li key={message.message_id} className="kb-list__item">
                <div className="kb-list__body">
                  <span className="kb-list__title">{message.text}</span>
                  <span className="kb-list__meta">
                    {message.surface} · {message.source} · {message.channel} ·{' '}
                    {new Date(message.created_at).toLocaleString(chronosSpeechLocale())}
                  </span>
                  <span className="chronos-mission-cell__id">
                    {mt('chronos_correlation', 'correlation')} {message.correlation_id}
                  </span>
                  <div className="pt-1">
                    <Button
                      variant="danger"
                      disabled={outboxTarget === message.message_id}
                      label={
                        outboxTarget === message.message_id
                          ? mt('chronos_clearing', 'clearing')
                          : mt('chronos_clear_outbox', 'clear outbox')
                      }
                      onClick={() => {
                        const prompt = buildDangerousActionPrompt(
                          `${message.surface} outbox`,
                          'clear outbox',
                          false
                        );
                        requestDangerousAction(
                          prompt.title,
                          prompt.detail,
                          prompt.confirmLabel,
                          () => clearOutboxMessage(message.surface, message.message_id)
                        );
                      }}
                    />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        id="projects"
        visible={panelVisible('projects')}
        title={mt('chronos_projects', 'Projects')}
        description={mt(
          'chronos_projects_description',
          'Projects hold the long-lived intent context. Use this panel to see which durable work, bindings, and results already have a parent container before creating new missions.'
        )}
      >
        {data.projects.length === 0 ? (
          <EmptyState
            title={mt('chronos_mi_no_projects', 'No projects registered yet')}
            body={mt(
              'chronos_mi_no_projects_detail',
              'Create the first project to anchor durable intent, bindings, and bootstrap work.'
            )}
          />
        ) : (
          <ul className="kb-list">
            {data.projects.map((project: any) => {
              const learnedRefs = learnedProjectRefs(project.project_id);
              const workLoop = buildProjectWorkLoopPreview(project);
              const management = (data.projectManagement || []).find(
                (item: any) => item.project.project_id === project.project_id
              );
              const focused = selectedProjectId === project.project_id;
              return (
                <li key={project.project_id} className="kb-list__item">
                  <div className="kb-list__body flex flex-col gap-2">
                    <NameWithId
                      title={project.name}
                      id={`${project.project_id} · ${project.tier}`}
                    />
                    {project.summary ? (
                      <span className="kb-list__meta">{project.summary}</span>
                    ) : null}
                    <KeyValue
                      items={[
                        {
                          label: mt('chronos_missions', 'missions'),
                          value: project.active_missions?.length ?? 0,
                        },
                        {
                          label: mt('chronos_bindings', 'bindings'),
                          value: project.service_bindings?.length ?? 0,
                        },
                        ...(project.bootstrap_work_items?.length
                          ? [
                              {
                                label: mt('chronos_next_work', 'next work'),
                                value: project.bootstrap_work_items
                                  .slice(0, 3)
                                  .map((item: any) => item.title)
                                  .join(' → '),
                              },
                            ]
                          : []),
                        ...(project.kickoff_task_session_id
                          ? [
                              {
                                label: mt('chronos_kickoff', 'kickoff'),
                                value: project.kickoff_task_session_id,
                                mono: true,
                              },
                            ]
                          : []),
                        ...(management
                          ? [
                              {
                                label: mt('chronos_project_lineage', 'project lineage'),
                                value: `${management.lineage.tracks.length} ${mt('chronos_tracks', 'tracks')} · ${management.lineage.tasks.length} ${mt('chronos_tasks', 'tasks')} · ${management.lineage.missions.length} ${mt('chronos_missions', 'missions')} · ${management.lineage.task_sessions.length} ${mt('chronos_task_sessions', 'task sessions')} · ${management.lineage.pipelines.length} ${mt('chronos_pipelines', 'pipelines')}`,
                              },
                            ]
                          : []),
                        ...(learnedRefs.length
                          ? [
                              {
                                label: mt('chronos_learned', 'learned'),
                                value: learnedRefs
                                  .map((candidate: any) => candidate.title)
                                  .join(', '),
                              },
                            ]
                          : []),
                      ]}
                    />
                    <WorkLoopDetail workLoop={workLoop} mt={mt} />
                    <div>
                      <Button
                        variant={focused ? 'ghost' : 'secondary'}
                        label={
                          focused
                            ? mt('chronos_focused', 'focused')
                            : mt('chronos_focus_project', 'focus project')
                        }
                        onClick={() => {
                          setSelectedProjectId(project.project_id);
                          setSelectedMissionId(
                            (project.active_missions && project.active_missions[0]) || null
                          );
                          setMessageMissionFilter(
                            (project.active_missions && project.active_missions[0]) || 'all'
                          );
                        }}
                      />
                    </div>
                  </div>
                  <StatusPill status={toKbStatus(project.status)} label={project.status} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        id="tracks"
        visible={panelVisible('tracks')}
        title={mt('chronos_tracks', 'Tracks')}
        description={mt(
          'chronos_tracks_description',
          'Tracks are the SDLC and gating lanes inside a project. Focus a track to review evidence, approvals, and durable work without assuming one project equals one lifecycle.'
        )}
      >
        {hydratedTracks.length === 0 ? (
          <Muted>{mt('chronos_no_tracks', 'No tracks registered yet.')}</Muted>
        ) : (
          <ul className="kb-list">
            {hydratedTracks.map((track: any) => {
              const gate = track.gate_readiness;
              return (
                <li key={track.track_id} className="kb-list__item">
                  <div className="kb-list__body flex flex-col gap-2">
                    <NameWithId
                      title={track.name}
                      id={`${track.track_id} · ${track.track_type} · ${track.lifecycle_model}`}
                    />
                    {track.summary ? <span className="kb-list__meta">{track.summary}</span> : null}
                    <KeyValue
                      items={[
                        {
                          label: mt('chronos_project', 'project'),
                          value: track.project_id,
                          mono: true,
                        },
                        {
                          label: mt('chronos_required_artifacts', 'required artifacts'),
                          value: track.required_artifacts?.length ?? 0,
                        },
                        ...(gate
                          ? [
                              {
                                label: mt('chronos_gate_readiness', 'gate readiness'),
                                value: `${gate.ready_gate_count}/${gate.total_gate_count}`,
                              },
                              {
                                label: mt('chronos_current_gate', 'current gate'),
                                value: gate.current_gate_id || (gate.ready ? 'ready' : '-'),
                                mono: true,
                              },
                            ]
                          : []),
                        ...(gate?.next_required_artifacts?.length
                          ? [
                              {
                                label: mt('chronos_next_required', 'next required'),
                                value: gate.next_required_artifacts
                                  .map((artifact: any) => artifact.artifact_id)
                                  .join(', '),
                                mono: true,
                              },
                            ]
                          : []),
                        ...(track.release_id
                          ? [
                              {
                                label: mt('chronos_mi_release', 'release'),
                                value: track.release_id,
                                mono: true,
                              },
                            ]
                          : []),
                      ]}
                    />
                    {gate ? (
                      <div className="kb-list__progress">
                        <span
                          className="kb-list__progress-track"
                          role="progressbar"
                          aria-label={mt('chronos_gate_readiness', 'gate readiness')}
                          aria-valuemin={0}
                          aria-valuemax={gate.total_gate_count || 1}
                          aria-valuenow={gate.ready_gate_count}
                        >
                          <span
                            className="kb-list__progress-fill"
                            style={{
                              width: `${Math.round(
                                (gate.ready_gate_count / Math.max(1, gate.total_gate_count)) * 100
                              )}%`,
                            }}
                          />
                        </span>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={selectedTrackId === track.track_id ? 'ghost' : 'secondary'}
                        label={
                          selectedTrackId === track.track_id
                            ? mt('chronos_focused', 'focused')
                            : mt('chronos_focus_track', 'focus track')
                        }
                        onClick={() => setSelectedTrackId(track.track_id)}
                      />
                      <Button
                        disabled={
                          !gate?.next_required_artifacts?.length ||
                          trackSeedTarget === track.track_id
                        }
                        label={
                          trackSeedTarget === track.track_id
                            ? mt('chronos_processing', 'processing')
                            : mt('chronos_seed_next_work', 'seed next work')
                        }
                        onClick={() =>
                          createTrackSeed(
                            track.track_id,
                            gate?.next_required_artifacts?.[0]?.artifact_id
                          )
                        }
                      />
                    </div>
                  </div>
                  <StatusPill status={toKbStatus(track.status)} label={track.status} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        id="service-bindings"
        visible={panelVisible('service-bindings')}
        title={mt('chronos_service_bindings', 'Service Bindings')}
        description={mt(
          'chronos_service_bindings_description',
          'Bindings define where Kyberion can read from or deliver to. This is the governed edge for GitHub, Slack, Drive, search, and other external systems.'
        )}
      >
        <div className="kb-table-wrap">
          <table className="kb-table">
            <thead>
              <tr>
                <th scope="col">{mt('chronos_mi_binding', 'Binding')}</th>
                <th scope="col">{mt('chronos_mi_allowed_actions', 'Allowed actions')}</th>
                <th scope="col" style={{ width: '8rem' }}>
                  {mt('chronos_mi_auth', 'Auth')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredServiceBindings.length === 0 ? (
                <tr>
                  <td className="kb-table__empty" colSpan={3}>
                    {mt('chronos_mi_no_bindings', 'No service bindings registered yet.')}
                  </td>
                </tr>
              ) : (
                filteredServiceBindings.slice(0, 8).map((binding: any) => (
                  <tr key={binding.binding_id}>
                    <td>
                      <NameWithId
                        title={`${binding.service_type} · ${binding.scope}`}
                        id={`${binding.binding_id} → ${binding.target}`}
                      />
                    </td>
                    <td className="chronos-muted">
                      {binding.allowed_actions.slice(0, 4).join(', ') || '-'}
                      {binding.allowed_actions.length > 4
                        ? ` +${binding.allowed_actions.length - 4}`
                        : ''}
                    </td>
                    <td data-mono="true">{binding.auth_mode || 'none'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        id="mission-seeds"
        visible={panelVisible('mission-seeds')}
        title={mt('chronos_mi_mission_seeds', 'Mission candidates')}
        description={mt(
          'chronos_mi_mission_seeds_detail',
          'Proposed durable work waits here before it becomes a full mission. Confirm that bootstrap output is structured and attributable.'
        )}
      >
        <Grid columns={4} gap="sm">
          <Metric
            label={mt('chronos_eligible', 'Ready to start')}
            value={data.missionSeedAssessment?.eligible ?? 0}
          />
          <Metric
            label={mt('chronos_flagged', 'Needs review')}
            value={data.missionSeedAssessment?.flagged ?? 0}
            tone={(data.missionSeedAssessment?.flagged ?? 0) > 0 ? 'warning' : undefined}
          />
          <Metric
            label={mt('chronos_mi_unassessed', 'Not assessed')}
            value={data.missionSeedAssessment?.unassessed ?? 0}
          />
          <Metric
            label={mt('chronos_promotable', 'Can become a mission')}
            value={data.missionSeedAssessment?.promotable ?? 0}
          />
        </Grid>
        {filteredMissionSeedsByTrack.length === 0 ? (
          <Muted>{mt('chronos_mi_no_seeds', 'No mission candidates recorded yet.')}</Muted>
        ) : (
          <ul className="kb-list">
            {filteredMissionSeedsByTrack.slice(0, 8).map((seed: any) => {
              const learnedRefs = learnedMissionSeedRefs(
                seed.seed_id,
                seed.project_id,
                seed.promoted_mission_id
              );
              const workLoop = buildMissionSeedWorkLoopPreview(seed);
              return (
                <li key={seed.seed_id} className="kb-list__item">
                  <div className="kb-list__body flex flex-col gap-2">
                    <NameWithId title={seed.title} id={seed.seed_id} />
                    {seed.summary ? <span className="kb-list__meta">{seed.summary}</span> : null}
                    <KeyValue
                      items={[
                        {
                          label: mt('chronos_project', 'project'),
                          value: seed.project_id,
                          mono: true,
                        },
                        {
                          label: mt('chronos_mi_specialist', 'specialist'),
                          value: seed.specialist_id,
                          mono: true,
                        },
                        {
                          label: mt('chronos_mi_source_work', 'source work'),
                          value: seed.source_work_id || '-',
                          mono: true,
                        },
                        {
                          label: mt('chronos_mi_type', 'type'),
                          value: seed.mission_type_hint || '-',
                          mono: true,
                        },
                        ...(seed.promoted_mission_id
                          ? [
                              {
                                label: mt('chronos_mi_mission', 'mission'),
                                value: seed.promoted_mission_id,
                                mono: true,
                              },
                            ]
                          : []),
                        ...(learnedRefs.length
                          ? [
                              {
                                label: mt('chronos_learned', 'learned'),
                                value: learnedRefs
                                  .map((candidate: any) => candidate.title)
                                  .join(', '),
                              },
                            ]
                          : []),
                      ]}
                    />
                    <WorkLoopDetail workLoop={workLoop} mt={mt} />
                    <div className="flex flex-wrap gap-2">
                      {typeof seed.metadata?.template_ref === 'string' ? (
                        <Button
                          variant="ghost"
                          label={mt('chronos_open_template', 'open template')}
                          onClick={() =>
                            openKnowledgeReference(seed.metadata?.template_ref as string)
                          }
                        />
                      ) : null}
                      {typeof seed.metadata?.skeleton_path === 'string' ? (
                        <Button
                          variant="ghost"
                          label={mt('chronos_open_skeleton', 'open skeleton')}
                          onClick={() =>
                            openRuntimeReference(seed.metadata?.skeleton_path as string)
                          }
                        />
                      ) : null}
                      <Button
                        variant="danger"
                        disabled={seed.status === 'promoted' || missionSeedTarget === seed.seed_id}
                        label={seedPromoteLabel(seed)}
                        onClick={() => promoteSeed(seed)}
                      />
                    </div>
                  </div>
                  <StatusPill status={toKbStatus(seed.status)} label={seed.status} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        id="skeleton-detail"
        visible={panelVisible('skeleton-detail')}
        title={mt('chronos_skeleton_detail', 'Skeleton Detail')}
      >
        {!selectedReferencePath || !referenceDetail ? (
          <Muted>
            {mt(
              'chronos_skeleton_detail_empty',
              'Select a track-generated skeleton to inspect its title, metadata, overview, and sections without leaving Chronos.'
            )}
          </Muted>
        ) : (
          <div className="flex flex-col gap-3">
            <NameWithId
              title={referenceDetail.title || mt('chronos_mi_reference', 'reference')}
              id={selectedReferencePath}
            />
            <Muted>
              {referenceDetail.summary || mt('chronos_no_summary', 'No summary available yet.')}
            </Muted>
            {selectedReferenceSeed ? (
              <KeyValue
                items={[
                  {
                    label: mt('chronos_mi_seed', 'candidate'),
                    value: selectedReferenceSeed.seed_id,
                    mono: true,
                  },
                  {
                    label: mt('chronos_track', 'track'),
                    value:
                      selectedReferenceSeed.track_name || selectedReferenceSeed.track_id || '-',
                  },
                ]}
              />
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                href={`${referenceDetail.endpoint}?path=${encodeURIComponent(selectedReferencePath)}`}
                label={
                  referenceDetail.openLabel || mt('chronos_open_raw_skeleton', 'open raw skeleton')
                }
              />
              {selectedReferenceSeed?.track_id ? (
                <Button
                  label={mt('chronos_focus_track', 'focus track')}
                  onClick={() => setSelectedTrackId(selectedReferenceSeed.track_id || null)}
                />
              ) : null}
              {selectedReferenceSeed &&
              typeof selectedReferenceSeed.metadata?.template_ref === 'string' &&
              selectedReferenceSeed.metadata.template_ref !== selectedReferencePath ? (
                <Button
                  label={mt('chronos_open_template', 'open template')}
                  onClick={() =>
                    openKnowledgeReference(selectedReferenceSeed.metadata?.template_ref as string)
                  }
                />
              ) : null}
              {selectedReferenceSeed &&
              typeof selectedReferenceSeed.metadata?.skeleton_path === 'string' &&
              selectedReferenceSeed.metadata.skeleton_path !== selectedReferencePath ? (
                <Button
                  label={mt('chronos_open_skeleton', 'open skeleton')}
                  onClick={() =>
                    openRuntimeReference(selectedReferenceSeed.metadata?.skeleton_path as string)
                  }
                />
              ) : null}
              {selectedReferenceSeed ? (
                <Button
                  variant="danger"
                  disabled={
                    selectedReferenceSeed.status === 'promoted' ||
                    missionSeedTarget === selectedReferenceSeed.seed_id
                  }
                  label={seedPromoteLabel(selectedReferenceSeed)}
                  onClick={() => promoteSeed(selectedReferenceSeed)}
                />
              ) : null}
            </div>
            {referenceMetadataEntries.length ? (
              <Disclosure summary={mt('chronos_metadata', 'Metadata')} open>
                <KeyValue
                  items={referenceMetadataEntries.map(([key, value]: [string, unknown]) => ({
                    label: key,
                    value: String(value),
                  }))}
                />
              </Disclosure>
            ) : null}
            {referenceDetail.body ? (
              <Disclosure summary={mt('chronos_overview', 'Overview')} open>
                {referenceDetail.body
                  .split('\n')
                  .filter((line: string) => line.trim())
                  .slice(0, 8)
                  .map((line: string, index: number) => (
                    <p key={`${line}-${index}`} className="kb-text kb-text--body">
                      {line}
                    </p>
                  ))}
              </Disclosure>
            ) : null}
            {referenceSections.map((section: any) => (
              <Disclosure
                key={section.title}
                summary={section.title || mt('chronos_mi_section', 'Section')}
              >
                {section.lines.some((line: string) => line.trim()) ? (
                  section.lines
                    .filter((line: string) => line.trim())
                    .slice(0, 12)
                    .map((line: string, index: number) => (
                      <p key={`${section.title}-${index}`} className="kb-text kb-text--body">
                        {line}
                      </p>
                    ))
                ) : (
                  <Muted>{mt('chronos_no_detail', 'No detail.')}</Muted>
                )}
              </Disclosure>
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}
