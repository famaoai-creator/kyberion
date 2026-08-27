import type { HandoffPacket } from './handoff-packet.js';

export type WorkItemStatus =
  'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'archived';
export type WorkItemPriority = 'low' | 'normal' | 'high' | 'urgent';
export type WorkItemSource = 'local' | 'github' | 'jira' | 'peer';
export type WorkBoardType = 'project' | 'personal' | 'peer' | 'review' | 'external';
export type WorkLeaseStatus = 'active' | 'released' | 'expired';

export interface WorkItemContext {
  organization_id?: string;
  tenant_slug?: string;
  mission_id?: string;
  project_id?: string;
  task_id?: string;
  work_shape?:
    | 'solution_project'
    | 'service_operation'
    | 'routine_operation'
    | 'incident_response'
    | 'governance_cadence'
    | 'improvement_experiment';
}

export interface WorkItem {
  item_id: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  source: WorkItemSource;
  source_ref: string;
  project_id: string;
  assignee_peer_id?: string;
  assignee_user_id?: string;
  labels: string[];
  dependencies: string[];
  version: number;
  created_at: string;
  updated_at: string;
  lease_id?: string;
  claimed_at?: string;
  released_at?: string;
  claimed_by_peer_id?: string;
  claimed_by_user_id?: string;
  current_attempt_id?: string;
  attempts?: WorkItemAttempt[];
  context?: WorkItemContext;
  metadata?: Record<string, unknown>;
}

export type WorkItemAttemptStatus =
  'running' | 'released' | 'completed' | 'blocked' | 'failed' | 'handed_off';

export interface WorkItemAttempt {
  attempt_id: string;
  run_id: string;
  status: WorkItemAttemptStatus;
  started_at: string;
  ended_at?: string;
  actor_peer_id?: string;
  actor_user_id?: string;
  lease_id?: string;
  summary?: string;
  blocked_reason?: string;
  failure_reason?: string;
  trace_id?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkBoardFilter {
  project_id?: string;
  source?: WorkItemSource | WorkItemSource[];
  status?: WorkItemStatus | WorkItemStatus[];
  assignee_peer_id?: string;
  assignee_user_id?: string;
  labels?: string[];
  text?: string;
}

export interface WorkBoard {
  board_id: string;
  name: string;
  type: WorkBoardType;
  description?: string;
  filters: WorkBoardFilter;
  sort_by: 'priority' | 'updated_at' | 'created_at' | 'status';
  lanes?: string[];
  created_at: string;
  updated_at: string;
}

export interface WorkLease {
  lease_id: string;
  item_id: string;
  holder_peer_id: string;
  holder_user_id?: string;
  purpose: string;
  status: WorkLeaseStatus;
  expires_at: string;
  created_at: string;
  renewed_at: string;
  released_at?: string;
  idempotency_key?: string;
  expected_version?: number;
  previous_lease_id?: string;
}

export type WorkCoordinationEventType =
  | 'item_imported'
  | 'item_created'
  | 'item_updated'
  | 'item_claimed'
  | 'item_released'
  | 'item_handed_off'
  | 'handoff_written'
  | 'handoff_consumed'
  | 'item_blocked'
  | 'item_unblocked'
  | 'item_attempt_started'
  | 'item_attempt_released'
  | 'item_attempt_completed'
  | 'item_attempt_blocked'
  | 'item_attempt_failed'
  | 'mission_handoff_written'
  | 'review_requested'
  | 'external_sync_pulled'
  | 'external_sync_pushed'
  | 'conflict_detected'
  | 'board_created'
  | 'board_updated'
  | 'lease_expired';

export interface CoordinationEvent {
  event_id: string;
  ts: string;
  event_type: WorkCoordinationEventType;
  item_id?: string;
  board_id?: string;
  lease_id?: string;
  actor_peer_id?: string;
  actor_user_id?: string;
  command_id?: string;
  idempotency_key?: string;
  expected_version?: number;
  status?: string;
  note?: string;
  payload?: Record<string, unknown>;
}

export interface CreateWorkItemInput {
  itemId?: string;
  title: string;
  description: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  source?: WorkItemSource;
  sourceRef?: string;
  projectId?: string;
  assigneePeerId?: string;
  assigneeUserId?: string;
  labels?: string[];
  dependencies?: string[];
  metadata?: Record<string, unknown>;
  attempts?: WorkItemAttempt[];
  currentAttemptId?: string;
  context?: WorkItemContext;
  rootDir?: string;
}

export interface UpdateWorkItemInput {
  itemId: string;
  expectedVersion?: number;
  title?: string;
  description?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  projectId?: string;
  assigneePeerId?: string;
  assigneeUserId?: string;
  labels?: string[];
  dependencies?: string[];
  metadata?: Record<string, unknown>;
  attempts?: WorkItemAttempt[];
  currentAttemptId?: string;
  context?: WorkItemContext;
  rootDir?: string;
}

export interface CreateBoardInput {
  boardId?: string;
  name: string;
  type: WorkBoardType;
  description?: string;
  filters?: WorkBoardFilter;
  sortBy?: WorkBoard['sort_by'];
  lanes?: string[];
}

export interface AppendCoordinationEventInput {
  eventType: WorkCoordinationEventType;
  itemId?: string;
  boardId?: string;
  leaseId?: string;
  actorPeerId?: string;
  actorUserId?: string;
  commandId?: string;
  idempotencyKey?: string;
  expectedVersion?: number;
  status?: string;
  note?: string;
  payload?: Record<string, unknown>;
}

export interface ClaimWorkItemInput {
  itemId: string;
  actorPeerId: string;
  actorUserId?: string;
  purpose: string;
  ttlMs?: number;
  expectedVersion?: number;
  idempotencyKey?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface ReleaseWorkItemInput {
  itemId: string;
  leaseId: string;
  actorPeerId: string;
  actorUserId?: string;
  expectedVersion?: number;
  nextStatus?: WorkItemStatus;
  summary?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface RenewWorkItemLeaseInput {
  leaseId: string;
  ttlMs?: number;
  expectedVersion?: number;
  /** Refuse renewal when this actor no longer holds the lease. */
  actorPeerId?: string;
}

export interface HandoffWorkItemInput {
  itemId: string;
  fromLeaseId: string;
  fromPeerId: string;
  toPeerId: string;
  toUserId?: string;
  purpose: string;
  ttlMs?: number;
  expectedVersion?: number;
  idempotencyKey?: string;
  traceId?: string;
  correlationId?: string;
  handoffPacket?: HandoffPacket;
  metadata?: Record<string, unknown>;
}

export interface RecordMissionHandoffInput {
  missionId: string;
  fromPersona: string;
  toPersona: string;
  handoffPacket: HandoffPacket;
}

export interface WorkItemFilter {
  boardId?: string;
  projectId?: string;
  tenantSlugs?: string[];
  tenant_slugs?: string[];
  organizationIds?: string[];
  organization_ids?: string[];
  projectIds?: string[];
  project_ids?: string[];
  source?: WorkItemSource | WorkItemSource[];
  status?: WorkItemStatus | WorkItemStatus[];
  assigneePeerId?: string;
  assigneeUserId?: string;
  labels?: string[];
  text?: string;
}
