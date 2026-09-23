import { useState } from 'react';
import { Button, Disclosure, EmptyState, KeyValue, StatusPill, Table } from '@agent/shared-ui';
import {
  ActionDetailList,
  ActionGuidance,
  ActionStatusBadge,
  buildDangerousActionPrompt,
  getActionDefinition,
  getGlobalSurfaceControlAction,
  getLatestSurfaceControlAction,
  surfaceToneStatus,
  toDomId,
} from './MissionIntelligenceViewHelpers';
import { Panel, RuntimeCell } from './MissionIntelligencePrimitives';
import {
  FeedActions,
  FeedItem,
  FeedList,
  formatDateTime,
  formatTime,
  loosePill,
  metaLine,
} from './MissionIntelligenceBFeed';

export function MissionIntelligenceRuntimePanel({ context }: { context: Record<string, any> }) {
  const {
    data,
    mt,
    panelVisible,
    browserSessionTarget,
    surfaceActionTarget,
    expandedSurfaceCardActionId,
    runBrowserSessionControl,
    runSurfaceControl,
    setExpandedSurfaceCardActionId,
    requestDangerousAction,
    hideSurfaceControl = false,
  } = context;

  const [expandedGlobalSurfaceActionId, setExpandedGlobalSurfaceActionId] = useState<string | null>(
    null
  );
  const getActionsByRisk = (actions: any[], risk: 'safe' | 'risky') =>
    actions.filter((action) => action.risk === risk);
  const getSharedDisabledReason = (actions: any[]) =>
    actions.map((action) => action.disabledReason).find((reason) => Boolean(reason)) || null;
  const getAvailableSurfaceActions = (payload: any, surfaceId: string) =>
    payload.controlActionAvailability.surface[surfaceId] || payload.controlActionCatalog.surface;

  const globalLatestAction = getGlobalSurfaceControlAction(data.controlActions);
  const globalRetryAction = globalLatestAction
    ? getActionDefinition(
        data.controlActionAvailability.globalSurface,
        globalLatestAction.operation
      )
    : null;
  const globalDisabledReason = getSharedDisabledReason(
    data.controlActionAvailability.globalSurface
  );

  return (
    <>
      <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
        <Panel
          id="orchestration-audit"
          visible={panelVisible('orchestration-audit')}
          title={mt('chronos_mip_orchestration_audit', 'Orchestration Audit')}
        >
          {data.recentEvents.length === 0 ? (
            <p className="kb-text kb-text--muted">
              {mt('chronos_mip_no_orchestration_events', 'No orchestration events yet.')}
            </p>
          ) : (
            <FeedList variant="timeline">
              {data.recentEvents.map((event: any, index: number) => (
                <FeedItem
                  key={`${event.ts}-${index}`}
                  title={event.decision}
                  titleId={event.mission_id || mt('chronos_mip_system', 'system')}
                  meta={formatDateTime(event.ts)}
                >
                  {event.why ? <p className="kb-text kb-text--muted">{event.why}</p> : null}
                </FeedItem>
              ))}
            </FeedList>
          )}
        </Panel>
        <Panel
          id="owner-summaries"
          visible={panelVisible('owner-summaries')}
          title={mt('chronos_owner_summaries', 'Owner summaries')}
        >
          <Table
            columns={[
              { key: 'mission', label: mt('chronos_mission', 'mission'), mono: true },
              { key: 'accepted', label: mt('chronos_mip_accepted', 'accepted'), align: 'end' },
              { key: 'reviewed', label: mt('chronos_mip_reviewed', 'reviewed'), align: 'end' },
              { key: 'completed', label: mt('chronos_col_completed', 'completed'), align: 'end' },
              { key: 'requested', label: mt('chronos_mip_requested', 'requested'), align: 'end' },
              { key: 'updated', label: mt('chronos_updated', 'updated') },
            ]}
            rows={data.ownerSummaries.map((summary: any) => ({
              mission: summary.mission_id,
              accepted: summary.accepted_count,
              reviewed: summary.reviewed_count,
              completed: summary.completed_count,
              requested: summary.requested_count,
              updated: formatDateTime(summary.ts),
            }))}
            empty={mt('chronos_no_owner_summaries', 'No owner summaries yet.')}
          />
        </Panel>

        <Panel
          id="runtime-summary"
          visible={panelVisible('runtime-summary')}
          title={mt('chronos_mip_operator_summary', 'Operator Summary')}
          description={mt(
            'chronos_mip_operator_summary_description',
            'Look at exceptions first, then mission readiness, then runtime and delivery counters. When these stay green, open governed drill-downs instead of adding controls here.'
          )}
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <RuntimeCell
              label={mt('chronos_ready', 'ready')}
              value={data.runtime.ready}
              accent="emerald"
            />
            <RuntimeCell
              label={mt('chronos_mip_busy', 'busy')}
              value={data.runtime.busy}
              accent="gold"
            />
            <RuntimeCell
              label={mt('chronos_mip_error', 'error')}
              value={data.runtime.error}
              accent="red"
            />
            <RuntimeCell
              label={mt('chronos_mip_leases', 'leases')}
              value={data.runtimeLeases.length}
              accent="cyan"
            />
            <RuntimeCell
              label={mt('chronos_mip_slack_outbox', 'slack outbox')}
              value={data.surfaceOutbox.slack}
              accent="gold"
            />
            <RuntimeCell
              label={mt('chronos_mip_chronos_outbox', 'chronos outbox')}
              value={data.surfaceOutbox.chronos}
              accent="cyan"
            />
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
        <Panel
          id="browser-sessions"
          visible={panelVisible('browser-sessions')}
          title={mt('chronos_mip_browser_session_oversight', 'Browser Session Oversight')}
        >
          {data.browserSessions.length === 0 ? (
            <EmptyState
              title={mt('chronos_mip_no_browser_sessions', 'No browser sessions recorded yet')}
              body={mt(
                'chronos_mip_no_browser_sessions_hint',
                'Open a browser task or capture a session to populate the registry.'
              )}
            />
          ) : (
            <FeedList>
              {data.browserSessions.map((session: any) => (
                <FeedItem
                  key={session.session_id}
                  title={session.session_id}
                  {...loosePill(session.lease_status)}
                  meta={metaLine([
                    `${mt('chronos_mip_active_tab', 'active tab')}: ${session.active_tab_id}`,
                    `${mt('chronos_mip_tabs', 'tabs')}: ${session.tab_count}`,
                  ])}
                >
                  <KeyValue
                    items={[
                      {
                        label: mt('chronos_mip_retained', 'retained'),
                        value: String(session.retained),
                        mono: true,
                      },
                      {
                        label: mt('chronos_mip_trail', 'trail'),
                        value: session.action_trail_count,
                        mono: true,
                      },
                      {
                        label: mt('chronos_updated', 'updated'),
                        value: formatTime(session.updated_at),
                      },
                      {
                        label: mt('chronos_mip_lease_expires', 'lease expires'),
                        value: session.lease_expires_at
                          ? formatTime(session.lease_expires_at)
                          : 'n/a',
                      },
                      ...(session.last_trace_path
                        ? [
                            {
                              label: mt('chronos_mip_trace', 'trace'),
                              value: session.last_trace_path,
                              mono: true,
                            },
                          ]
                        : []),
                    ]}
                  />
                  <FeedActions>
                    <Button
                      label={
                        browserSessionTarget === `${session.session_id}:close_browser_session`
                          ? mt('chronos_mip_closing', 'closing')
                          : mt('chronos_mip_close_session', 'close session')
                      }
                      variant="secondary"
                      onClick={() =>
                        runBrowserSessionControl(session.session_id, 'close_browser_session')
                      }
                      disabled={
                        browserSessionTarget === `${session.session_id}:close_browser_session` ||
                        session.lease_status !== 'active'
                      }
                    />
                    <Button
                      label={
                        browserSessionTarget === `${session.session_id}:restart_browser_session`
                          ? mt('chronos_mip_restarting', 'restarting')
                          : mt('chronos_mip_restart_session', 'restart session')
                      }
                      variant="secondary"
                      onClick={() =>
                        runBrowserSessionControl(session.session_id, 'restart_browser_session')
                      }
                      disabled={
                        browserSessionTarget === `${session.session_id}:restart_browser_session`
                      }
                    />
                  </FeedActions>
                  <Disclosure
                    summary={`${mt('chronos_mip_recent_browser_trail', 'recent browser trail')} (${session.recent_actions.length})`}
                  >
                    {session.recent_actions.length === 0 ? (
                      <p className="kb-text kb-text--muted">
                        {mt('chronos_mip_no_browser_actions', 'No recorded browser actions.')}
                      </p>
                    ) : (
                      <FeedList variant="timeline">
                        {session.recent_actions.map((action: any, index: number) => (
                          <FeedItem
                            key={`${session.session_id}-${action.ts}-${index}`}
                            title={`${action.kind} · ${action.op}`}
                            meta={metaLine([
                              formatTime(action.ts),
                              action.tab_id && `${mt('chronos_mip_tab', 'tab')}: ${action.tab_id}`,
                              action.ref && `${mt('chronos_mip_ref', 'ref')}: ${action.ref}`,
                              action.selector &&
                                `${mt('chronos_mip_selector', 'selector')}: ${action.selector}`,
                            ])}
                          />
                        ))}
                      </FeedList>
                    )}
                  </Disclosure>
                </FeedItem>
              ))}
            </FeedList>
          )}
        </Panel>

        <Panel
          id="browser-guidance"
          visible={panelVisible('browser-guidance')}
          title={mt('chronos_mip_browser_guidance', 'Browser Guidance')}
          description={mt(
            'chronos_mip_browser_guidance_description',
            'Browser sessions stay fast only while they are leased. Prefer snapshot + ref, then export recorded trails as Playwright specs in either strict or hint mode.'
          )}
        >
          <div className="grid grid-cols-2 gap-3">
            <RuntimeCell
              label={mt('chronos_mip_browser_sessions', 'browser sessions')}
              value={data.browserSessions.length}
              accent="cyan"
            />
            <RuntimeCell
              label={mt('chronos_mip_active_leases', 'active leases')}
              value={
                data.browserSessions.filter((session: any) => session.lease_status === 'active')
                  .length
              }
              accent="emerald"
            />
            <RuntimeCell
              label={mt('chronos_mip_retained', 'retained')}
              value={data.browserSessions.filter((session: any) => session.retained).length}
              accent="gold"
            />
            <RuntimeCell
              label={mt('chronos_mip_expired', 'expired')}
              value={
                data.browserSessions.filter((session: any) => session.lease_status === 'expired')
                  .length
              }
              accent="red"
            />
          </div>
        </Panel>
        <Panel
          id="browser-conversation-sessions"
          visible={panelVisible('browser-conversation-sessions')}
          title={mt('chronos_mip_browser_tasks', 'Browser Tasks')}
        >
          {data.browserConversationSessions.length === 0 ? (
            <EmptyState
              title={mt('chronos_mip_no_browser_tasks', 'No browser tasks recorded yet')}
              body={mt(
                'chronos_mip_no_browser_tasks_hint',
                'Start a task from the browser surface to capture guided confirmations and result state.'
              )}
            />
          ) : (
            <FeedList>
              {data.browserConversationSessions.map((session: any) => (
                <FeedItem
                  key={session.session_id}
                  title={session.goal_summary || session.session_id}
                  titleId={session.session_id}
                  {...loosePill(session.status)}
                  meta={metaLine([
                    `${mt('chronos_mip_surface', 'surface')}: ${session.surface}`,
                    `${mt('chronos_mip_mode', 'mode')}: ${session.mode}`,
                    formatTime(session.updated_at),
                  ])}
                >
                  <KeyValue
                    items={[
                      {
                        label: mt('chronos_mip_current_step', 'current step'),
                        value: session.active_step || 'n/a',
                      },
                      {
                        label: mt('chronos_mip_waiting_confirmation', 'waiting for confirmation'),
                        value: String(session.pending_confirmation),
                        mono: true,
                      },
                      {
                        label: mt('chronos_mip_available_actions', 'available actions'),
                        value: session.candidate_target_count,
                        mono: true,
                      },
                    ]}
                  />
                </FeedItem>
              ))}
            </FeedList>
          )}
        </Panel>
      </section>

      {!hideSurfaceControl || panelVisible('control-model') ? (
        <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          {!hideSurfaceControl ? (
            <Panel
              id="surface-control"
              visible={panelVisible('surface-control')}
              title={mt('chronos_mip_surface_control', 'Surface Control')}
              description={globalDisabledReason || undefined}
              actions={
                <>
                  {globalLatestAction ? (
                    <>
                      <ActionStatusBadge action={globalLatestAction} />
                      {globalLatestAction.event_id ? (
                        <Button
                          label={
                            expandedGlobalSurfaceActionId === globalLatestAction.event_id
                              ? mt('chronos_hide_latest_action', 'hide latest action')
                              : mt('chronos_show_latest_action', 'show latest action')
                          }
                          variant="ghost"
                          onClick={() =>
                            setExpandedGlobalSurfaceActionId((current) =>
                              current === globalLatestAction.event_id
                                ? null
                                : globalLatestAction.event_id || null
                            )
                          }
                        />
                      ) : null}
                      {globalLatestAction.status === 'failed' ? (
                        <Button
                          label={
                            surfaceActionTarget === `all:${globalLatestAction.operation}`
                              ? mt('chronos_retrying', 'retrying')
                              : mt('chronos_retry_latest_action', 'retry latest action')
                          }
                          variant="danger"
                          onClick={() => runSurfaceControl(null, globalLatestAction.operation)}
                          disabled={
                            !globalRetryAction?.enabled ||
                            surfaceActionTarget === `all:${globalLatestAction.operation}`
                          }
                        />
                      ) : null}
                    </>
                  ) : null}
                  {data.controlActionAvailability.globalSurface.map((action: any) => (
                    <Button
                      key={action.operation}
                      label={
                        surfaceActionTarget === `all:${action.operation}`
                          ? mt('chronos_working', 'working')
                          : action.label
                      }
                      variant="secondary"
                      onClick={() => runSurfaceControl(null, action.operation)}
                      disabled={
                        !action.enabled || surfaceActionTarget === `all:${action.operation}`
                      }
                    />
                  ))}
                </>
              }
            >
              {globalLatestAction?.event_id &&
              expandedGlobalSurfaceActionId === globalLatestAction.event_id ? (
                <div className="flex flex-col gap-2">
                  <ActionDetailList
                    actionId={globalLatestAction.event_id}
                    details={data.controlActionDetails}
                  />
                  <ActionGuidance
                    latestAction={globalLatestAction}
                    availableActions={data.controlActionAvailability.globalSurface}
                  />
                </div>
              ) : null}
              {data.surfaces.length === 0 ? (
                <p className="kb-text kb-text--muted">
                  {mt('chronos_no_managed_surfaces', 'No managed surfaces.')}
                </p>
              ) : (
                <FeedList>
                  {data.surfaces.map((surface: any) => {
                    const surfaceActions = getAvailableSurfaceActions(data, surface.id);
                    const safeSurfaceActions = getActionsByRisk(surfaceActions, 'safe');
                    const riskySurfaceActions = getActionsByRisk(surfaceActions, 'risky');
                    const safeDisabledReason = getSharedDisabledReason(safeSurfaceActions);
                    const riskyDisabledReason = getSharedDisabledReason(riskySurfaceActions);
                    const latestAction = getLatestSurfaceControlAction(
                      data.controlActions,
                      surface.id
                    );
                    const retryAction = latestAction
                      ? getActionDefinition(surfaceActions, latestAction.operation)
                      : null;
                    const health = loosePill(surface.health);
                    return (
                      <FeedItem
                        id={toDomId('surface', surface.id)}
                        key={surface.id}
                        title={surface.id}
                        status={health.status}
                        statusLabel={health.statusLabel || surface.health}
                        meta={metaLine([
                          surface.kind,
                          surface.startupMode || mt('chronos_background', 'background'),
                          surface.running
                            ? mt('chronos_running', 'running')
                            : mt('chronos_stopped', 'stopped'),
                          `pid: ${surface.pid ?? '-'}`,
                          surface.detail && `${mt('chronos_detail', 'detail')}: ${surface.detail}`,
                        ])}
                      >
                        <KeyValue
                          items={[
                            {
                              label: mt('chronos_control_summary', 'control summary'),
                              value: surface.controlSummary,
                            },
                            ...(surface.controlRequestedBy
                              ? [
                                  {
                                    label: mt('chronos_requested_by', 'requested by'),
                                    value: surface.controlRequestedBy,
                                    mono: true,
                                  },
                                ]
                              : []),
                          ]}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusPill
                            status={surfaceToneStatus(surface.controlTone)}
                            label={surface.controlSummary}
                          />
                          {latestAction ? (
                            <>
                              <span className="kb-text kb-text--caption">
                                {mt('chronos_last_control_action', 'last control action')}
                              </span>
                              <ActionStatusBadge action={latestAction} />
                            </>
                          ) : null}
                        </div>
                        <FeedActions>
                          {latestAction?.event_id ? (
                            <Button
                              label={
                                expandedSurfaceCardActionId === latestAction.event_id
                                  ? mt('chronos_hide_latest_action', 'hide latest action')
                                  : mt('chronos_show_latest_action', 'show latest action')
                              }
                              variant="ghost"
                              onClick={() =>
                                setExpandedSurfaceCardActionId((current: string | null) =>
                                  current === latestAction.event_id
                                    ? null
                                    : latestAction.event_id || null
                                )
                              }
                            />
                          ) : null}
                          {latestAction?.event_id && latestAction.status === 'failed' ? (
                            <Button
                              label={
                                surfaceActionTarget === `${surface.id}:${latestAction.operation}`
                                  ? mt('chronos_retrying', 'retrying')
                                  : mt('chronos_retry_latest_action', 'retry latest action')
                              }
                              variant="danger"
                              onClick={() => runSurfaceControl(surface.id, latestAction.operation)}
                              disabled={
                                !retryAction?.enabled ||
                                surfaceActionTarget === `${surface.id}:${latestAction.operation}`
                              }
                            />
                          ) : null}
                        </FeedActions>
                        <div className="flex flex-col gap-1">
                          <span className="kb-text kb-text--caption">
                            {mt('chronos_safe_actions', 'safe actions')}
                          </span>
                          <FeedActions>
                            {safeSurfaceActions.map((action: any) => (
                              <Button
                                key={action.operation}
                                label={
                                  surfaceActionTarget === `${surface.id}:${action.operation}`
                                    ? mt('chronos_working', 'working')
                                    : action.label
                                }
                                variant="secondary"
                                onClick={() => runSurfaceControl(surface.id, action.operation)}
                                disabled={
                                  !action.enabled ||
                                  surfaceActionTarget === `${surface.id}:${action.operation}`
                                }
                              />
                            ))}
                          </FeedActions>
                          {safeDisabledReason ? (
                            <span className="kb-list__meta">{safeDisabledReason}</span>
                          ) : null}
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="kb-text kb-text--caption">
                            {mt(
                              'chronos_risky_actions_approval_required',
                              'risky actions · approval required'
                            )}
                          </span>
                          <FeedActions>
                            {riskySurfaceActions.map((action: any) => (
                              <Button
                                key={action.operation}
                                label={
                                  surfaceActionTarget === `${surface.id}:${action.operation}`
                                    ? mt('chronos_working', 'working')
                                    : action.label
                                }
                                variant="danger"
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
                              />
                            ))}
                          </FeedActions>
                          {riskyDisabledReason ? (
                            <span className="kb-list__meta">{riskyDisabledReason}</span>
                          ) : null}
                        </div>
                        {latestAction?.event_id &&
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
                        ) : null}
                      </FeedItem>
                    );
                  })}
                </FeedList>
              )}
            </Panel>
          ) : null}

          <Panel
            id="control-model"
            visible={panelVisible('control-model')}
            title={mt('chronos_control_model', 'Control Model')}
            description={mt(
              'chronos_control_model_description',
              'Chronos is a control surface. It does not mutate mission or runtime state directly. Each button issues a deterministic backend action through mission_controller, agent-runtime-supervisor, or surface_runtime, then refreshes the control-plane view.'
            )}
          >
            {null}
          </Panel>
        </section>
      ) : null}
    </>
  );
}
