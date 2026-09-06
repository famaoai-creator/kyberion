import {
  ActionDetailList,
  ActionStatusBadge,
  buildApprovalWorkLoopPreview,
  buildArtifactWorkLoopPreview,
  buildDistillCandidateWorkLoopPreview,
} from './MissionIntelligenceViewHelpers';
import { Panel } from './MissionIntelligencePrimitives';
import { chronosSpeechLocale } from '../lib/ux-vocabulary';

export function MissionIntelligenceApprovalsPanel(context: Record<string, any>) {
  const {
    data,
    mt,
    filteredRecentArtifactsByTrack,
    filteredDistillCandidatesByTrack,
    filteredPendingApprovalsByTrack,
    filteredMemoryCandidatesByTrack,
    decideApproval,
    approvalTarget,
    decideDistillCandidate,
    distillCandidateTarget,
    runMemoryPromotion,
    memoryPromotionTarget,
    expandedActionId,
    jumpToTarget,
    panelVisible,
  } = context;

  return (
    <>
      <section className="grid gap-4">
        <Panel
          id="approvals"
          visible={panelVisible('approvals')}
          title={mt('chronos_approvals', 'Approvals')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_approvals_description',
              'Approvals keep authority explicit. Review pending risky actions here before they cross a governed boundary.'
            )}
          </div>
          <div className="space-y-3">
            {filteredPendingApprovalsByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_pending_approvals', 'No pending approvals.')}
              </div>
            ) : (
              filteredPendingApprovalsByTrack.map((approval) => (
                <div
                  key={approval.id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildApprovalWorkLoopPreview(approval);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                            {approval.title}
                          </div>
                          <div className="rounded-full kb-status-negative-surface px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-status-negative">
                            {approval.riskLevel}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] kb-text-secondary">{approval.summary}</div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                          <div>
                            {mt('chronos_channel', 'channel')}:{' '}
                            <span className="font-mono kb-text-primary">{approval.channel}</span>
                          </div>
                          <div>
                            {mt('chronos_kind', 'kind')}:{' '}
                            <span className="font-mono kb-text-primary">{approval.kind}</span>
                          </div>
                          <div>
                            {mt('chronos_service', 'service')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {approval.serviceId || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_mission', 'mission')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {approval.missionId || '-'}
                            </span>
                          </div>
                        </div>
                        {approval.pendingRoles.length > 0 ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            pending roles:{' '}
                            <span className="kb-text-secondary">
                              {approval.pendingRoles.join(', ')}
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
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => decideApproval(approval, 'approved')}
                            disabled={approvalTarget === approval.id}
                            className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {approvalTarget === approval.id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_approve', 'approve')}
                          </button>
                          <button
                            type="button"
                            onClick={() => decideApproval(approval, 'rejected')}
                            disabled={approvalTarget === approval.id}
                            className="rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {approvalTarget === approval.id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_reject', 'reject')}
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
          id="recent-artifacts"
          visible={panelVisible('recent-artifacts')}
          title={mt('chronos_recent_artifacts', 'Recent artifacts')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_recent_artifacts_description',
              'This panel shows the latest recorded artifacts with their project, mission, task, and storage location.'
            )}
          </div>
          <div className="space-y-3">
            {filteredRecentArtifactsByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_recent_artifacts', 'No recorded artifacts yet.')}
              </div>
            ) : (
              filteredRecentArtifactsByTrack.map((artifact) => (
                <div
                  key={artifact.artifact_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildArtifactWorkLoopPreview(artifact);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                            {artifact.artifact_id}
                          </div>
                          <div className="rounded-full kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-accent">
                            {artifact.kind}
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                          <div>
                            project:{' '}
                            <span className="font-mono kb-text-primary">
                              {artifact.project_id || 'standalone'}
                            </span>
                          </div>
                          <div>
                            mission:{' '}
                            <span className="font-mono kb-text-primary">
                              {artifact.mission_id || '-'}
                            </span>
                          </div>
                          <div>
                            task:{' '}
                            <span className="font-mono kb-text-primary">
                              {artifact.task_session_id || '-'}
                            </span>
                          </div>
                          <div>
                            storage:{' '}
                            <span className="font-mono kb-text-primary">
                              {artifact.storage_class}
                            </span>
                          </div>
                        </div>
                        {(artifact.path || artifact.external_ref || artifact.preview_text) && (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            {artifact.preview_text ||
                              artifact.external_ref ||
                              artifact.path?.split('/').pop()}
                          </div>
                        )}
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
                      </>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="distill-candidates"
          visible={panelVisible('distill-candidates')}
          title={mt('chronos_distill_candidates', 'Distill Candidates')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_distill_candidates_description',
              'Completed work can become reusable organizational memory. This queue highlights outcome-backed candidates that may be promoted into patterns, SOPs, or governed knowledge later.'
            )}
          </div>
          <div className="space-y-3">
            {filteredDistillCandidatesByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_distill_candidates', 'No distill candidates recorded yet.')}
              </div>
            ) : (
              filteredDistillCandidatesByTrack.slice(0, 10).map((candidate) => (
                <div
                  key={candidate.candidate_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildDistillCandidateWorkLoopPreview(candidate);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                            {candidate.title}
                          </div>
                          <div className="rounded-full kb-status-info-surface px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-status-info">
                            {candidate.target_kind}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] kb-text-secondary">
                          {candidate.summary}
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                          <div>
                            {mt('chronos_source', 'source')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.source_type}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_project', 'project')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.project_id || 'standalone'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_mission', 'mission')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.mission_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_task', 'task')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.task_session_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_status', 'status')}:{' '}
                            <span className="font-mono kb-text-primary">{candidate.status}</span>
                          </div>
                          <div>
                            {mt('chronos_specialist', 'specialist')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.specialist_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_tier', 'tier')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.tier || 'confidential'}
                            </span>
                          </div>
                        </div>
                        {candidate.artifact_ids && candidate.artifact_ids.length ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            artifacts:{' '}
                            <span className="kb-text-secondary">
                              {candidate.artifact_ids.join(', ')}
                            </span>
                          </div>
                        ) : null}
                        {candidate.evidence_refs && candidate.evidence_refs.length ? (
                          <div className="mt-1 text-[10px] kb-text-muted">
                            evidence:{' '}
                            <span className="kb-text-secondary">
                              {candidate.evidence_refs.join(', ')}
                            </span>
                          </div>
                        ) : null}
                        {candidate.promoted_ref ? (
                          <div className="mt-1 text-[10px] kb-text-muted">
                            promoted ref:{' '}
                            <span className="font-mono kb-text-secondary">
                              {candidate.promoted_ref}
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
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => decideDistillCandidate(candidate, 'promote')}
                            disabled={
                              candidate.status !== 'proposed' ||
                              distillCandidateTarget === candidate.candidate_id
                            }
                            className="rounded-lg border kb-status-info-border kb-status-info-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-info transition hover:kb-status-info-surface disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {distillCandidateTarget === candidate.candidate_id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_promote', 'promote')}
                          </button>
                          <button
                            type="button"
                            onClick={() => decideDistillCandidate(candidate, 'archive')}
                            disabled={
                              candidate.status !== 'proposed' ||
                              distillCandidateTarget === candidate.candidate_id
                            }
                            className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {distillCandidateTarget === candidate.candidate_id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_archive', 'archive')}
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
          id="memory-promotion-queue"
          visible={panelVisible('memory-promotion-queue')}
          title="Memory Promotion Queue"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Approved memory candidates can be promoted into governed knowledge in bulk. Run a
            dry-run first to inspect queue scope, then execute promotion.
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => runMemoryPromotion(true)}
              disabled={memoryPromotionTarget !== null}
              className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {memoryPromotionTarget === 'dry-run'
                ? mt('chronos_processing', 'processing')
                : 'dry-run'}
            </button>
            <button
              type="button"
              onClick={() => runMemoryPromotion(false)}
              disabled={memoryPromotionTarget !== null}
              className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-40"
            >
              {memoryPromotionTarget === 'promote'
                ? mt('chronos_processing', 'processing')
                : 'promote approved'}
            </button>
          </div>
          <div className="space-y-3">
            {filteredMemoryCandidatesByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No memory candidates queued.
              </div>
            ) : (
              filteredMemoryCandidatesByTrack.slice(0, 12).map((candidate) => (
                <div
                  key={candidate.candidate_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                      {candidate.candidate_id}
                    </div>
                    <div className="rounded-full kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-accent">
                      {candidate.status}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      kind:{' '}
                      <span className="font-mono kb-text-primary">
                        {candidate.proposed_memory_kind}
                      </span>
                    </div>
                    <div>
                      tier:{' '}
                      <span className="font-mono kb-text-primary">
                        {candidate.sensitivity_tier}
                      </span>
                    </div>
                    <div className="col-span-2">
                      source:{' '}
                      <span className="font-mono kb-text-primary">{candidate.source_ref}</span>
                    </div>
                    <div className="col-span-2">
                      evidence:{' '}
                      <span className="kb-text-secondary">
                        {candidate.evidence_refs?.join(', ') || '-'}
                      </span>
                    </div>
                  </div>
                  {candidate.promoted_ref ? (
                    <div className="mt-2 text-[10px] kb-text-muted">
                      promoted ref:{' '}
                      <span className="font-mono kb-text-secondary">{candidate.promoted_ref}</span>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel
          id="recent-control-actions"
          visible={panelVisible('recent-control-actions')}
          title={mt('chronos_recent_control_actions', 'Recent control actions')}
        >
          <div className="space-y-3">
            {data.controlActions.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_recent_control_actions', 'No recent mission or screen actions.')}
              </div>
            ) : (
              data.controlActions.map((action, index) => (
                <div
                  key={`${action.event_id || action.ts}-${index}`}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      {action.kind} · {action.operation}
                    </div>
                    <ActionStatusBadge action={action} />
                  </div>
                  <div className="mt-2 text-[11px] kb-text-primary">{action.target}</div>
                  <div className="mt-1 text-[10px] kb-text-muted">
                    {mt('chronos_requested_by', 'Requested by')}:{' '}
                    <span className="font-mono kb-text-secondary">{action.requested_by}</span>
                  </div>
                  {action.event_id && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedActionId((current) =>
                            current === action.event_id ? null : action.event_id || null
                          )
                        }
                        className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                      >
                        {expandedActionId === action.event_id
                          ? mt('chronos_hide_details', 'Hide details')
                          : mt('chronos_show_details', 'Show details')}
                      </button>
                      {action.target !== 'surface-runtime' && (
                        <button
                          type="button"
                          onClick={() => jumpToTarget(action)}
                          className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent"
                        >
                          {mt('chronos_jump_to_target', 'Jump to target')}
                        </button>
                      )}
                    </div>
                  )}
                  {action.event_id && expandedActionId === action.event_id && (
                    <ActionDetailList
                      actionId={action.event_id}
                      details={data.controlActionDetails}
                    />
                  )}
                  {action.error && (
                    <div className="mt-2 text-[10px] kb-status-negative">{action.error}</div>
                  )}
                  <div className="mt-2 text-[9px] font-mono kb-text-muted">
                    {new Date(action.ts).toLocaleString(chronosSpeechLocale())}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>
    </>
  );
}
