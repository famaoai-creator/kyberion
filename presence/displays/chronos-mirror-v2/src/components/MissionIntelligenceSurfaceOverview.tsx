import {
  Badge,
  Button,
  Callout,
  Disclosure,
  EmptyState,
  Grid,
  KeyValue,
  Metric,
  Section,
  StatusPill,
} from '@agent/shared-ui';
import type { KbStatus } from '@agent/core/a2ui-catalog';
import type { AttentionItem } from '../lib/operator-console';
import {
  attentionActionLabel,
  attentionNextStepLabel,
  attentionReasonLabel,
  attentionSourceLabel,
} from './MissionIntelligenceViewHelpers';
import { MetricCard, MiniSummaryCard, Panel } from './MissionIntelligencePrimitives';
import { chronosSpeechLocale, uxMessage } from '../lib/ux-vocabulary';

const ATTENTION_STATUS: Record<string, KbStatus> = {
  critical: 'blocked',
  warning: 'pending',
  info: 'active',
};

/**
 * UI-07: overview blocks above the mission panels — the mission-overview
 * toggle, "what to check next" and "items needing attention" on the Work
 * page; the operator-console hero on the focused (surface) views. Built from
 * shared Section / List / Metric / KeyValue, explanations live in the
 * section descriptions.
 */
export function MissionIntelligenceSurfaceOverview({ context }: { context: Record<string, any> }) {
  const {
    workspace,
    focusedView,
    onClearFocus,
    locale,
    buildMissionIntentSummary,
    resolveNextActionRoute,
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

  const scrollTo = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  const company = data.company;
  const yesNo = (value: boolean) => (value ? mt('chronos_yes', 'Yes') : mt('chronos_no', 'No'));
  const availability = (value: boolean) =>
    value ? mt('chronos_mi_available', 'available') : mt('chronos_mi_missing', 'missing');

  return (
    <>
      {workspace === 'missions' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="kb-text kb-text--title">
              {mt('chronos_mission_overview_eyebrow', 'Mission overview')}
            </p>
            <p className="kb-text kb-text--muted">
              {mt(
                'chronos_mission_overview_hint',
                'Start with the goal, current state, and next step. Open related information only when you need it.'
              )}
            </p>
          </div>
          <Button
            variant="secondary"
            label={
              showMissionDetails
                ? mt('chronos_hide_mission_details', 'Hide related information')
                : mt('chronos_show_mission_details', 'Show related information')
            }
            onClick={() => setShowMissionDetails((current: boolean) => !current)}
          />
        </div>
      ) : null}

      {workspace === 'surface' && !selectedProject && !selectedMissionId && (
        <Section
          title={mt('chronos_mi_welcome_title', 'Welcome to the Mirror.')}
          description={mt(
            'chronos_mi_welcome_detail',
            'Chronos is your operational control tower. Use these shortcuts to start monitoring or to intervene in active agent workflows.'
          )}
        >
          <div className="flex flex-wrap gap-2">
            <Button
              label={mt('chronos_mi_monitor_missions', 'Monitor missions')}
              onClick={() => scrollTo('mission-control-plane')}
            />
            <Button
              label={mt('chronos_mi_system_health', 'System health')}
              onClick={() => scrollTo('runtime-lease-doctor')}
            />
            <Button
              label={mt('chronos_mi_intervention', 'Intervention')}
              onClick={() => scrollTo('recent-surface-outbox')}
            />
          </div>
        </Section>
      )}

      {workspace === 'surface' && focusedView && (
        <Callout
          tone="info"
          title={focusTitle}
          body={mt(
            'chronos_mi_focused_view_detail',
            'The main console is showing one operator view at full width.'
          )}
        >
          {onClearFocus ? (
            <div className="kb-callout__action">
              <Button
                label={mt('chronos_mi_show_full_console', 'Show full console')}
                onClick={onClearFocus}
              />
            </div>
          ) : null}
        </Callout>
      )}

      {workspace === 'surface' ? (
        <Section
          title={mt(
            'chronos_mission_hero_title',
            'Start with exceptions, then intervene only where mission flow or runtime governance needs help.'
          )}
          description={mt(
            'chronos_mission_hero_description',
            'Chronos is the operational mirror for Kyberion. Confirm what is active, identify what is blocked, open A2UI drill-downs when you need detail, and keep control actions deliberate and minimal.'
          )}
        >
          <Grid columns={4} gap="sm">
            <Metric
              label={mt('chronos_sc_needs_attention_label', 'Needs attention')}
              value={attentionItems.length}
              tone={attentionItems.length > 0 ? 'warning' : undefined}
            />
            <Metric
              label={mt('chronos_missions_label', 'Missions')}
              value={data.activeMissions.length}
            />
            <Metric
              label={mt('chronos_runtime_incidents', 'Runtime incidents')}
              value={data.runtimeDoctor.length}
              tone={data.runtimeDoctor.length > 0 ? 'danger' : undefined}
            />
            <Metric
              label={mt('chronos_delivery_queue', 'Delivery queue')}
              value={data.surfaceOutbox.slack + data.surfaceOutbox.chronos}
            />
          </Grid>
          {actionResult ? (
            <Callout
              tone="info"
              title={mt('chronos_last_action', 'last action')}
              body={actionResult}
            />
          ) : null}
          <KeyValue
            items={[
              {
                label: mt('chronos_access', 'access'),
                value: `${data.accessRole}${
                  data.accessRole === 'readonly'
                    ? mt(
                        'chronos_control_actions_disabled',
                        ' · control actions are disabled until a localadmin token is provided or localhost auto-admin is enabled.'
                      )
                    : mt('chronos_control_actions_enabled', ' · control actions enabled.')
                }`,
              },
            ]}
          />
          {company ? (
            <Disclosure
              summary={`${mt('chronos_mi_company_context', 'Company Context')} · ${company.name}`}
            >
              <KeyValue
                items={[
                  { label: 'ID', value: company.companyId, mono: true },
                  {
                    label: mt('chronos_mi_sovereign', 'sovereign'),
                    value: company.sovereign || mt('chronos_unknown', 'unknown'),
                  },
                  {
                    label: mt('chronos_mi_vision', 'vision'),
                    value: `${company.vision.title || company.vision.sourcePath} (${company.visionRef})`,
                  },
                  {
                    label: mt('chronos_mi_org_chart', 'org chart'),
                    value: `${company.orgChart.positionCount} / ${company.orgChart.domainCount}${
                      company.orgChart.topLevelRoles.length > 0
                        ? ` · ${company.orgChart.topLevelRoles.join(', ')}`
                        : ''
                    }`,
                  },
                  {
                    label: mt('chronos_mi_decision_rights', 'decision rights'),
                    value: `${company.decisionRights.ruleCount}${
                      company.decisionRights.sourceKind
                        ? ` · ${company.decisionRights.sourceKind}`
                        : ''
                    }`,
                  },
                  {
                    label: mt('chronos_mi_financial', 'financial'),
                    value: company.financial.exists
                      ? [
                          `${company.financial.periodCount}`,
                          company.financial.latestPeriodId || '',
                          typeof company.financial.latestGrossProfitJpy === 'number'
                            ? `¥${company.financial.latestGrossProfitJpy.toLocaleString(
                                chronosSpeechLocale()
                              )}`
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : availability(false),
                  },
                  {
                    label: mt('chronos_mi_finance_controller', 'finance controller'),
                    value: `${company.financeController.mode}${
                      company.financeController.shouldCutCosts
                        ? ` · ${mt('chronos_mi_cost_cutting', 'cost cutting')}`
                        : ''
                    }${
                      company.financeController.reasons.length > 0
                        ? ` · ${company.financeController.reasons.length}`
                        : ''
                    }`,
                  },
                  {
                    label: 'OKR',
                    value: company.okr.exists
                      ? `${company.okr.objectiveCount} / ${company.okr.keyResultCount} KR · ${company.okr.progressPercent}%${
                          company.okr.latestObjective ? ` · ${company.okr.latestObjective}` : ''
                        }`
                      : availability(false),
                  },
                  {
                    label: mt('chronos_mi_audit', 'audit'),
                    value: `${company.approvalAudit.total} · ${mt('chronos_mi_allowed', 'allowed')} ${company.approvalAudit.allowed} · ${mt('chronos_mi_denied', 'denied')} ${company.approvalAudit.denied}${
                      company.approvalAudit.latestCorrelationId
                        ? ` · ${company.approvalAudit.latestCorrelationId}`
                        : ''
                    }`,
                  },
                  {
                    label: mt('chronos_mi_audit_drilldown', 'audit drilldown'),
                    value: `${company.approvalAuditDrilldown.byDecisionType.length} / ${company.approvalAuditDrilldown.byCorrelationId.length}`,
                  },
                ]}
              />
            </Disclosure>
          ) : null}
          {selectedProject ? (
            <FocusRow
              label={mt('chronos_mi_project_focus', 'Project focus')}
              title={selectedProject.name}
              id={selectedProject.project_id}
              meta={
                selectedProjectManagement
                  ? uxMessage(
                      'chronos_mi_project_lineage',
                      {
                        tasks: selectedProjectManagement.lineage.tasks.length,
                        sessions: selectedProjectManagement.lineage.task_sessions.length,
                      },
                      '{tasks} tasks / {sessions} task sessions',
                      locale
                    )
                  : undefined
              }
              clearLabel={mt('chronos_mi_clear_focus', 'Clear focus')}
              onClear={() => setSelectedProjectId(null)}
            />
          ) : null}
          {selectedMission ? (
            <FocusRow
              label={mt('chronos_mi_mission_focus', 'Mission focus')}
              title={buildMissionIntentSummary(data, selectedMission)}
              id={selectedMission.missionId}
              clearLabel={mt('chronos_mi_clear_focus', 'Clear focus')}
              onClear={() => setSelectedMissionId(null)}
            />
          ) : null}
          {selectedTrack ? (
            <FocusRow
              label={mt('chronos_mi_track_focus', 'Track focus')}
              title={selectedTrack.name}
              id={selectedTrack.track_id}
              clearLabel={mt('chronos_mi_clear_focus', 'Clear focus')}
              onClear={() => setSelectedTrackId(null)}
            />
          ) : null}
          <p className="kb-text kb-text--muted">
            {mt(
              'chronos_surface_explanation',
              'Surfaces are the explainable boundary between people and agent execution. Chronos clarifies mission flow, runtime risk, and intervention points before offering controls.'
            )}
          </p>
        </Section>
      ) : null}

      {workspace === 'surface' ? (
        <Grid columns={4} gap="sm">
          <MetricCard
            label={mt('chronos_attention_queue', 'Needs Attention')}
            value={String(attentionItems.length)}
            detail={mt(
              'chronos_attention_queue_detail',
              'Mission blockers, runtime incidents, and delivery exceptions'
            )}
          />
          <MetricCard
            label={mt('chronos_runtime_governance', 'Runtime governance')}
            value={`${data.runtimeDoctor.length}/${data.runtimeLeases.length}`}
            detail={`ready=${data.runtime.ready} busy=${data.runtime.busy} error=${data.runtime.error}`}
          />
          <MetricCard
            label={mt('chronos_delivery_exceptions', 'Delivery exceptions')}
            value={String(data.surfaceOutbox.slack + data.surfaceOutbox.chronos)}
            detail={mt(
              'chronos_delivery_exceptions_detail',
              'Outbox entries awaiting operator attention'
            )}
          />
          <MetricCard
            label={mt('chronos_memory_promotion', 'Learning registration')}
            value={String(memoryCandidateCount)}
            detail={
              nextAction
                ? `${mt('chronos_next_action_prefix', '次')}: ${nextAction.reason}`
                : mt('chronos_memory_no_action', 'No learning needs to be registered now')
            }
          />
        </Grid>
      ) : null}

      {workspace === 'surface' && !focusedView ? (
        <EmptyState
          title={mt(
            'chronos_mi_active_surface_title',
            'Select a mission or task to open its focused surface'
          )}
          body={mt(
            'chronos_mi_active_surface_detail',
            'Active Surface is intentionally limited to the current task context. Use Missions, Work Items, or Operations to choose what to inspect.'
          )}
        />
      ) : null}

      <Panel
        id="next-actions"
        visible={panelVisible('next-actions')}
        title={mt('chronos_recommended_next_actions', 'What to check next')}
        description={mt(
          'chronos_recommended_next_actions_detail',
          'Suggestions based on the current state. Run only the actions needed to move the mission forward.'
        )}
      >
        <Grid columns={3} gap="sm">
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
            label={mt('chronos_promotable', 'Can become a mission')}
            value={data.missionSeedAssessment?.promotable ?? 0}
          />
        </Grid>
        {nextActions.length === 0 ? (
          <p className="kb-text kb-text--muted">
            {mt('chronos_no_immediate_next_actions', 'There are no actions needed right now.')}
          </p>
        ) : (
          <ul className="kb-list">
            {nextActions.map((action: any) => {
              const route = resolveNextActionRoute(action);
              const facts = [
                { label: mt('chronos_risk', 'Risk'), value: String(action.risk), mono: true },
                {
                  label: mt('chronos_approval_required', 'Approval needed'),
                  value: yesNo(Boolean(action.approval_required)),
                },
                ...(route
                  ? [{ label: mt('chronos_route', 'Destination'), value: route.label }]
                  : []),
                ...(action.suggested_command
                  ? [
                      {
                        label: mt('chronos_command', 'Command'),
                        value: action.suggested_command,
                        mono: true,
                      },
                    ]
                  : []),
              ];
              return (
                <li key={action.action_id} className="kb-list__item">
                  <div className="kb-list__body">
                    <span className="kb-list__title">{action.reason}</span>
                    <span className="chronos-mission-cell__id">{action.action_id}</span>
                    <KeyValue items={facts} />
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        variant="primary"
                        disabled={nextActionTarget === action.action_id}
                        label={
                          nextActionTarget === action.action_id
                            ? mt('chronos_processing', 'processing')
                            : mt('chronos_execute', 'Run')
                        }
                        onClick={() => runNextAction(action)}
                      />
                      {route ? (
                        <Button
                          label={mt('chronos_jump', 'Open')}
                          onClick={() => jumpToNextActionRoute(action)}
                        />
                      ) : null}
                      {action.action_id === 'chronos-promote-memory' ? (
                        <Button
                          disabled={memoryPromotionTarget !== null}
                          label={
                            memoryPromotionTarget === 'dry-run'
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_dry_run', 'Preview')
                          }
                          onClick={() => runMemoryPromotion(true)}
                        />
                      ) : null}
                    </div>
                  </div>
                  <Badge label={String(action.next_action_type)} tone="accent" />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        id="needs-attention"
        visible={panelVisible('needs-attention')}
        title={mt('chronos_needs_attention_panel', 'Items needing attention')}
        description={mt(
          'chronos_needs_attention_detail',
          'Prioritized items to review. Each item shows why it matters, where it came from, and the next safe step.'
        )}
      >
        <Grid columns={4} gap="sm">
          <MiniSummaryCard
            label={mt('chronos_work_needing_attention', 'Work to review')}
            value={missionExceptions.length}
            detail={mt(
              'chronos_work_needing_attention_detail',
              'Requests or missions that need a person to check them'
            )}
          />
          <MiniSummaryCard
            label={mt('chronos_runtime_incidents', 'Runtime issues')}
            value={data.runtimeDoctor.length}
            detail={mt(
              'chronos_runtime_incidents_detail',
              'Execution environments with a diagnostic issue'
            )}
          />
          <MiniSummaryCard
            label={mt('chronos_surface_incidents', 'Surface issues')}
            value={surfaceExceptions.length}
            detail={mt('chronos_surface_incidents_detail', 'Managed surfaces that need review')}
          />
          <MiniSummaryCard
            label={mt('chronos_delivery_exceptions', 'Delivery issues')}
            value={deliveryExceptions.length}
            detail={mt('chronos_delivery_exceptions_detail', 'Pending or leftover delivery issues')}
          />
        </Grid>
        {attentionItems.length === 0 ? (
          <p className="kb-text kb-text--muted">
            {mt(
              'chronos_no_operator_intervention',
              'No immediate action is needed. Open details if you need to investigate further.'
            )}
          </p>
        ) : (
          <ul className="kb-list">
            {attentionItems.map((item: AttentionItem) => (
              <li key={item.id} className="kb-list__item">
                <div className="kb-list__body">
                  <span className="kb-list__title">{attentionReasonLabel(item, locale)}</span>
                  <span className="kb-list__meta">
                    {attentionSourceLabel(item, locale)}
                    {item.nextStep ? ` · ${attentionNextStepLabel(item, locale)}` : ''}
                  </span>
                  <span className="chronos-mission-cell__id">{item.title}</span>
                  {item.actionLabel ? (
                    <div className="pt-1">
                      <Button
                        label={attentionActionLabel(item, locale)}
                        onClick={() => runAttentionAction(item)}
                      />
                    </div>
                  ) : null}
                </div>
                <StatusPill
                  status={ATTENTION_STATUS[item.tone] || 'active'}
                  label={
                    item.tone === 'critical'
                      ? mt('chronos_critical', 'Urgent')
                      : item.tone === 'warning'
                        ? mt('chronos_warning', 'Caution')
                        : mt('chronos_info', 'Information')
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function FocusRow({
  label,
  title,
  id,
  meta,
  clearLabel,
  onClear,
}: {
  label: string;
  title: string;
  id: string;
  meta?: string;
  clearLabel: string;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="chronos-mission-cell">
        <span className="kb-text kb-text--caption">{label}</span>
        <span className="kb-list__title">{title}</span>
        <span className="chronos-mission-cell__id">{id}</span>
        {meta ? <span className="chronos-muted">{meta}</span> : null}
      </div>
      <Button variant="ghost" label={clearLabel} onClick={onClear} />
    </div>
  );
}
