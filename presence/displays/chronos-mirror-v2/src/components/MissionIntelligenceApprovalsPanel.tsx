import { Button, KeyValue, Table } from '@agent/shared-ui';
import {
  ActionDetailList,
  ActionStatusBadge,
  buildApprovalWorkLoopPreview,
  buildArtifactWorkLoopPreview,
  buildDistillCandidateWorkLoopPreview,
} from './MissionIntelligenceViewHelpers';
import { Panel } from './MissionIntelligencePrimitives';
import {
  FeedActions,
  FeedItem,
  FeedList,
  WorkLoopDisclosure,
  formatDateTime,
  loosePill,
  looseStatus,
  metaLine,
} from './MissionIntelligenceBFeed';

export function MissionIntelligenceApprovalsPanel({ context }: { context: Record<string, any> }) {
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
    setExpandedActionId,
    jumpToTarget,
    panelVisible,
  } = context;

  return (
    <>
      <section className="grid gap-4">
        <Panel
          id="approvals"
          visible={panelVisible('approvals')}
          title={mt('chronos_approvals_title', 'Approvals')}
          description={mt(
            'chronos_approvals_description',
            'Approvals keep authority explicit. Review pending risky actions here before they cross a governed boundary.'
          )}
        >
          {filteredPendingApprovalsByTrack.length === 0 ? (
            <p className="kb-text kb-text--muted">
              {mt('chronos_mip_no_pending_approvals', 'No pending approvals.')}
            </p>
          ) : (
            <FeedList>
              {filteredPendingApprovalsByTrack.map((approval: any) => (
                <FeedItem
                  key={approval.id}
                  title={approval.title}
                  titleId={approval.missionId}
                  status="pending"
                  statusLabel={approval.riskLevel}
                  meta={approval.summary}
                >
                  <KeyValue
                    items={[
                      {
                        label: mt('chronos_channel', 'channel'),
                        value: approval.channel,
                        mono: true,
                      },
                      { label: mt('chronos_mip_kind', 'kind'), value: approval.kind, mono: true },
                      {
                        label: mt('chronos_mip_service', 'service'),
                        value: approval.serviceId || '-',
                        mono: true,
                      },
                      ...(approval.pendingRoles.length > 0
                        ? [
                            {
                              label: mt('chronos_mip_pending_roles', 'pending roles'),
                              value: approval.pendingRoles.join(', '),
                            },
                          ]
                        : []),
                    ]}
                  />
                  <WorkLoopDisclosure workLoop={buildApprovalWorkLoopPreview(approval)} mt={mt} />
                  <FeedActions>
                    <Button
                      label={
                        approvalTarget === approval.id
                          ? mt('chronos_mip_processing', 'processing')
                          : mt('chronos_approve', 'approve')
                      }
                      variant="primary"
                      onClick={() => decideApproval(approval, 'approved')}
                      disabled={approvalTarget === approval.id}
                    />
                    <Button
                      label={
                        approvalTarget === approval.id
                          ? mt('chronos_mip_processing', 'processing')
                          : mt('chronos_reject', 'reject')
                      }
                      variant="danger"
                      onClick={() => decideApproval(approval, 'rejected')}
                      disabled={approvalTarget === approval.id}
                    />
                  </FeedActions>
                </FeedItem>
              ))}
            </FeedList>
          )}
        </Panel>

        <Panel
          id="recent-artifacts"
          visible={panelVisible('recent-artifacts')}
          title={mt('chronos_recent_artifacts', 'Recent artifacts')}
          description={mt(
            'chronos_recent_artifacts_description',
            'This panel shows the latest recorded artifacts with their project, mission, task, and storage location.'
          )}
        >
          {filteredRecentArtifactsByTrack.length === 0 ? (
            <p className="kb-text kb-text--muted">
              {mt('chronos_no_recent_artifacts', 'No recorded artifacts yet.')}
            </p>
          ) : (
            <FeedList>
              {filteredRecentArtifactsByTrack.map((artifact: any) => (
                <FeedItem
                  key={artifact.artifact_id}
                  title={
                    artifact.preview_text ||
                    artifact.external_ref ||
                    artifact.path?.split('/').pop() ||
                    artifact.artifact_id
                  }
                  titleId={artifact.artifact_id}
                  status="n/a"
                  statusLabel={artifact.kind}
                >
                  <KeyValue
                    items={[
                      {
                        label: mt('chronos_project', 'project'),
                        value: artifact.project_id || mt('chronos_mip_standalone', 'standalone'),
                        mono: true,
                      },
                      {
                        label: mt('chronos_mission', 'mission'),
                        value: artifact.mission_id || '-',
                        mono: true,
                      },
                      {
                        label: mt('chronos_mip_task', 'task'),
                        value: artifact.task_session_id || '-',
                        mono: true,
                      },
                      {
                        label: mt('chronos_mip_storage', 'storage'),
                        value: artifact.storage_class,
                        mono: true,
                      },
                    ]}
                  />
                  <WorkLoopDisclosure workLoop={buildArtifactWorkLoopPreview(artifact)} mt={mt} />
                </FeedItem>
              ))}
            </FeedList>
          )}
        </Panel>

        <Panel
          id="distill-candidates"
          visible={panelVisible('distill-candidates')}
          title={mt('chronos_mip_distill_candidates', 'Distill Candidates')}
          description={mt(
            'chronos_mip_distill_candidates_description',
            'Completed work can become reusable organizational memory. This queue highlights outcome-backed candidates that may be promoted into patterns, SOPs, or governed knowledge later.'
          )}
        >
          {filteredDistillCandidatesByTrack.length === 0 ? (
            <p className="kb-text kb-text--muted">
              {mt('chronos_mip_no_distill_candidates', 'No distill candidates recorded yet.')}
            </p>
          ) : (
            <FeedList>
              {filteredDistillCandidatesByTrack.slice(0, 10).map((candidate: any) => (
                <FeedItem
                  key={candidate.candidate_id}
                  title={candidate.title}
                  titleId={candidate.candidate_id}
                  {...loosePill(candidate.status)}
                  meta={metaLine([candidate.target_kind, candidate.summary])}
                >
                  <KeyValue
                    items={[
                      {
                        label: mt('chronos_mip_source', 'source'),
                        value: candidate.source_type,
                        mono: true,
                      },
                      {
                        label: mt('chronos_project', 'project'),
                        value: candidate.project_id || mt('chronos_mip_standalone', 'standalone'),
                        mono: true,
                      },
                      {
                        label: mt('chronos_mission', 'mission'),
                        value: candidate.mission_id || '-',
                        mono: true,
                      },
                      {
                        label: mt('chronos_mip_task', 'task'),
                        value: candidate.task_session_id || '-',
                        mono: true,
                      },
                      {
                        label: mt('chronos_mip_specialist', 'specialist'),
                        value: candidate.specialist_id || '-',
                        mono: true,
                      },
                      {
                        label: mt('chronos_mip_tier', 'tier'),
                        value: candidate.tier || 'confidential',
                        mono: true,
                      },
                      ...(candidate.artifact_ids && candidate.artifact_ids.length
                        ? [
                            {
                              label: mt('chronos_mip_artifacts', 'artifacts'),
                              value: candidate.artifact_ids.join(', '),
                            },
                          ]
                        : []),
                      ...(candidate.evidence_refs && candidate.evidence_refs.length
                        ? [
                            {
                              label: mt('chronos_mip_evidence', 'evidence'),
                              value: candidate.evidence_refs.join(', '),
                            },
                          ]
                        : []),
                      ...(candidate.promoted_ref
                        ? [
                            {
                              label: mt('chronos_mip_promoted_ref', 'promoted ref'),
                              value: candidate.promoted_ref,
                              mono: true,
                            },
                          ]
                        : []),
                    ]}
                  />
                  <WorkLoopDisclosure
                    workLoop={buildDistillCandidateWorkLoopPreview(candidate)}
                    mt={mt}
                  />
                  <FeedActions>
                    <Button
                      label={
                        distillCandidateTarget === candidate.candidate_id
                          ? mt('chronos_mip_processing', 'processing')
                          : mt('chronos_mip_promote', 'promote')
                      }
                      variant="primary"
                      onClick={() => decideDistillCandidate(candidate, 'promote')}
                      disabled={
                        candidate.status !== 'proposed' ||
                        distillCandidateTarget === candidate.candidate_id
                      }
                    />
                    <Button
                      label={
                        distillCandidateTarget === candidate.candidate_id
                          ? mt('chronos_mip_processing', 'processing')
                          : mt('chronos_mip_archive', 'archive')
                      }
                      variant="secondary"
                      onClick={() => decideDistillCandidate(candidate, 'archive')}
                      disabled={
                        candidate.status !== 'proposed' ||
                        distillCandidateTarget === candidate.candidate_id
                      }
                    />
                  </FeedActions>
                </FeedItem>
              ))}
            </FeedList>
          )}
        </Panel>

        <Panel
          id="memory-promotion-queue"
          visible={panelVisible('memory-promotion-queue')}
          title={mt('chronos_mip_memory_promotion_queue', 'Memory Promotion Queue')}
          description={mt(
            'chronos_mip_memory_promotion_description',
            'Approved memory candidates can be promoted into governed knowledge in bulk. Run a dry-run first to inspect queue scope, then execute promotion.'
          )}
          actions={
            <>
              <Button
                label={
                  memoryPromotionTarget === 'dry-run'
                    ? mt('chronos_mip_processing', 'processing')
                    : mt('chronos_mip_dry_run', 'dry-run')
                }
                variant="secondary"
                onClick={() => runMemoryPromotion(true)}
                disabled={memoryPromotionTarget !== null}
              />
              <Button
                label={
                  memoryPromotionTarget === 'promote'
                    ? mt('chronos_mip_processing', 'processing')
                    : mt('chronos_mip_promote_approved', 'promote approved')
                }
                variant="primary"
                onClick={() => runMemoryPromotion(false)}
                disabled={memoryPromotionTarget !== null}
              />
            </>
          }
        >
          <Table
            columns={[
              { key: 'candidate', label: mt('chronos_mip_candidate', 'candidate'), mono: true },
              { key: 'status', label: mt('chronos_col_status', 'status') },
              { key: 'kind', label: mt('chronos_mip_kind', 'kind') },
              { key: 'tier', label: mt('chronos_mip_tier', 'tier') },
              { key: 'source', label: mt('chronos_mip_source', 'source'), mono: true },
              { key: 'evidence', label: mt('chronos_mip_evidence', 'evidence') },
              {
                key: 'promoted',
                label: mt('chronos_mip_promoted_ref', 'promoted ref'),
                mono: true,
              },
            ]}
            rows={filteredMemoryCandidatesByTrack.slice(0, 12).map((candidate: any) => ({
              candidate: candidate.candidate_id,
              status:
                looseStatus(candidate.status) === 'n/a'
                  ? candidate.status
                  : looseStatus(candidate.status),
              kind: candidate.proposed_memory_kind,
              tier: candidate.sensitivity_tier,
              source: candidate.source_ref,
              evidence: candidate.evidence_refs?.join(', ') || '-',
              promoted: candidate.promoted_ref || '-',
            }))}
            empty={mt('chronos_mip_no_memory_candidates', 'No memory candidates queued.')}
          />
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel
          id="recent-control-actions"
          visible={panelVisible('recent-control-actions')}
          title={mt('chronos_recent_control_actions', 'Recent control actions')}
        >
          {data.controlActions.length === 0 ? (
            <p className="kb-text kb-text--muted">
              {mt('chronos_no_recent_control_actions', 'No recent mission or screen actions.')}
            </p>
          ) : (
            <FeedList variant="timeline">
              {data.controlActions.map((action: any, index: number) => (
                <FeedItem
                  key={`${action.event_id || action.ts}-${index}`}
                  title={action.target}
                  meta={metaLine([
                    `${action.kind} · ${action.operation}`,
                    `${mt('chronos_requested_by', 'Requested by')}: ${action.requested_by}`,
                    formatDateTime(action.ts),
                  ])}
                >
                  <div>
                    <ActionStatusBadge action={action} />
                  </div>
                  {action.error ? <p className="chronos-scope__error">{action.error}</p> : null}
                  {action.event_id ? (
                    <FeedActions>
                      <Button
                        label={
                          expandedActionId === action.event_id
                            ? mt('chronos_hide_details', 'Hide details')
                            : mt('chronos_show_details', 'Show details')
                        }
                        variant="ghost"
                        onClick={() =>
                          setExpandedActionId((current: string | null) =>
                            current === action.event_id ? null : action.event_id || null
                          )
                        }
                      />
                      {action.target !== 'surface-runtime' ? (
                        <Button
                          label={mt('chronos_jump_to_target', 'Jump to target')}
                          variant="secondary"
                          onClick={() => jumpToTarget(action)}
                        />
                      ) : null}
                    </FeedActions>
                  ) : null}
                  {action.event_id && expandedActionId === action.event_id ? (
                    <ActionDetailList
                      actionId={action.event_id}
                      details={data.controlActionDetails}
                    />
                  ) : null}
                </FeedItem>
              ))}
            </FeedList>
          )}
        </Panel>
      </section>
    </>
  );
}
