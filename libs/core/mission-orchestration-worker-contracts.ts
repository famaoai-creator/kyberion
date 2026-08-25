import { isSurfaceAsyncChannel, type SurfaceAsyncChannel } from './channel-surface-types.js';
import type { ArtifactReviewerProfile } from './mission-review-gates.js';
import { extractSurfaceBlocks } from './surface-response-blocks.js';

export interface SlackPayload {
  /** Originating surface (SN-01); absent on legacy events, treated as 'slack'. */
  surface?: string;
  channel: string;
  threadTs: string;
  sourceText?: string;
  proposal?: Record<string, unknown>;
  tier?: 'personal' | 'confidential' | 'public';
  persona?: string;
  missionType?: string;
  teamRoles?: string[];
}

export function payloadSurface(payload: SlackPayload): SurfaceAsyncChannel {
  const surface = String(payload.surface || '')
    .trim()
    .toLowerCase();
  return isSurfaceAsyncChannel(surface) ? surface : 'slack';
}

export interface MissionControlPayload {
  operation:
    'resume' | 'pause' | 'cancel' | 'refresh_team' | 'prewarm_team' | 'staff_team' | 'finish';
  requested_by_surface?: 'chronos';
}

export interface SurfaceControlPayload {
  operation: 'reconcile' | 'status' | 'start' | 'stop';
  surfaceId?: string;
  requested_by_surface?: 'chronos';
}

export type TaskResultBlock = NonNullable<
  ReturnType<typeof extractSurfaceBlocks>['taskResults']
>[number];

export interface PlannedNextTask {
  task_id: string;
  status?: string;
  rework_count?: number;
  assigned_to?: {
    role?: string;
    agent_id?: string;
  };
  description?: string;
  deliverable?: string;
  target_path?: string;
  dependencies?: string[];
  /** Explicit shared-resource claims; agent identity is intentionally not a claim. */
  resource_claims?: string[];
  acceptance_criteria?: string[];
  risk?: string;
  expected_output_format?: 'text' | 'files' | 'structured';
  estimated_scope?: 'S' | 'M' | 'L';
  timeout_ms?: number;
  review_target?: string;
  review_round?: number;
  artifact_review_profile?: ArtifactReviewerProfile & {
    artifact_path?: string;
    artifact_sha256?: string;
    implementer_agent_ids: string[];
  };
  artifact_review_receipt?: string;
  reconciliation?: Record<string, unknown> & {
    evidence?: Array<{
      path: string;
      sha256?: string;
      kind: 'artifact' | 'test_report' | 'review' | 'trace' | 'receipt';
    }>;
  };
  last_result?: TaskResultBlock;
  review_findings?: Array<{
    severity: 'must_fix' | 'should_fix' | 'nit';
    location: string;
    instruction: string;
  }>;
  rework_packet?: {
    from_task: string;
    findings: Array<{
      severity: 'must_fix' | 'should_fix' | 'nit';
      location: string;
      instruction: string;
    }>;
    round: number;
  };
  /** Opt-in autonomous goal-driven execution. */
  goal_driven?: boolean;
  /** Opt-in multi-turn goal budgets, honored only when goal_driven is enabled. */
  goal_budget?: {
    tokenBudget?: number;
    turnBudget?: number;
    wallClockBudgetMs?: number;
  };
}
