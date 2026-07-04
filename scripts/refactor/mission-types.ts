/**
 * scripts/refactor/mission-types.ts
 * Core type definitions for the Mission Controller.
 */

export interface MissionState {
  mission_id: string;
  mission_type?: string;
  tenant_id?: string;
  /**
   * Tenant slug for multi-tenant isolation (lowercase, ^[a-z][a-z0-9-]{1,30}$).
   * When set, tier-guard rejects writes/reads under another tenant's
   * confidential prefix; audit-chain entries inherit this slug.
   * `tenant_id` (legacy) and `tenant_slug` may both be set during migration;
   * `tenant_slug` is authoritative for runtime isolation checks.
   */
  tenant_slug?: string;
  /**
   * Cross-tenant brokering declaration. When present, tier-guard allows
   * the active persona to read/write across the listed tenants — but
   * only those — and every access emits a `tenant.broker_access`
   * audit event. The mission must live in the public tier.
   * See knowledge/product/orchestration/cross-tenant-brokering-protocol.md.
   */
  cross_tenant_brokerage?: {
    source_tenants: string[];
    purpose: string;
    approved_by?: string;
    approved_at?: string;
    expires_at?: string;
  };
  vision_ref?: string;
  tier: 'personal' | 'confidential' | 'public';
  status:
    | 'planned'
    | 'active'
    | 'validating'
    | 'distilling'
    | 'completed'
    | 'paused'
    | 'failed'
    | 'archived';
  execution_mode: 'local' | 'delegated';
  relationships?: {
    prerequisites?: string[];
    successors?: string[];
    blockers?: string[];
    project?: {
      project_id?: string;
      project_path?: string;
      relationship_type: 'belongs_to' | 'supports' | 'governs' | 'independent';
      affected_artifacts?: string[];
      gate_impact?: 'none' | 'informational' | 'review_required' | 'blocking';
      traceability_refs?: string[];
      note?: string;
    };
    track?: {
      track_id?: string;
      track_name?: string;
      track_type?:
        | 'delivery'
        | 'release'
        | 'change'
        | 'incident'
        | 'operations'
        | 'governance'
        | 'compliance'
        | 'research';
      lifecycle_model?: string;
      relationship_type: 'belongs_to' | 'supports' | 'governs' | 'independent';
      traceability_refs?: string[];
      note?: string;
    };
  };
  delegation?: {
    agent_id: string;
    a2a_message_id: string;
    remote_repo_url?: string;
    last_sync_ts: string;
    verification_status: 'pending' | 'verified' | 'rejected';
    evidence_hashes?: Record<string, string>;
  };
  priority: number;
  assigned_persona: string;
  confidence_score: number;
  git: {
    branch: string;
    start_commit: string;
    latest_commit: string;
    checkpoints: Array<{ task_id: string; commit_hash: string; ts: string }>;
  };
  outcome_contract?: {
    outcome_id: string;
    requested_result: string;
    deliverable_kind: string;
    success_criteria: string[];
    evidence_required: boolean;
    expected_artifacts: Array<{ kind: string; storage_class: string }>;
    verification_method: 'self_check' | 'review_gate' | 'human_acceptance' | 'test';
  };
  context?: {
    last_action?: string;
    next_step?: string;
    blockers?: string[];
    associated_projects?: string[];
    routing_decision_summary?: string;
    context_pack_id?: string;
    context_pack_path?: string;
    context_pack_summary?: string;
    context_pack_pruning_summary?: {
      budget_chars: number;
      estimated_chars: number;
      kept_sections: string[];
      pruned_sections: string[];
      rollup_path?: string;
      rollup_summary: string;
    };
    work_item_dispatch_summary?: {
      item_id?: string;
      team_role?: string;
      assignee_peer_id?: string;
      execution_mode?: string;
      cognitive_route_summary?: string;
      drift_watchdog_summary?: string;
      ticket_state_after?: string;
      response_path?: string;
    };
    ticket_dispatch_summary?: {
      task_id?: string;
      team_role?: string;
      work_item_id?: string;
      targets?: string[];
      live_targets?: string[];
      status?: string;
      ticket_files?: string[];
      live_results?: Record<string, unknown>;
    };
    mission_finish_trace_summary?: {
      traceId: string;
      spans: number;
      events: number;
      artifacts: number;
      errors: number;
    };
    mission_finish_trace_persisted_path?: string;
    mission_completion_next_action?: {
      title: string;
      request: string;
      delivered: string[];
      gaps: string[];
      next_step: string;
      satisfied: boolean;
      confidence: number;
      evidence_refs: string[];
    };
    mission_completion_summary?: {
      requested_result: string;
      satisfied: boolean;
      delivered: string[];
      gaps: string[];
      next_step: string;
      confidence: number;
    };
    intent_delta_summary?: {
      checked_at: string;
      passed: boolean;
      verdict: string;
      drift_score: number;
      message: string;
    };
  };
  history: Array<{ ts: string; event: string; from?: string; to?: string; note: string }>;
}

export type MissionRelationships = NonNullable<MissionState['relationships']>;

export const BOOLEAN_FLAGS = new Set([
  '--ephemeral',
  '--refresh',
  '--seal',
  '--force',
  '--execute',
  '--dry-run',
  '--help',
  '-h',
  '--json',
  '--summary',
  '--compact',
  '--active-only',
  '--ready-only',
  '--missing-only',
  '--selected-only',
]);
export const VALUE_FLAGS = new Set([
  '--persona',
  '--tenant',
  '--tenant-id',
  '--tenant-slug',
  '--organization-id',
  '--org',
  '--source',
  '--mission-type',
  '--vision',
  '--vision-ref',
  '--tier',
  '--relationships',
  '--relationships-json',
  '--relationships-file',
  '--mission',
  '--mission-id',
  '--project-id',
  '--project-path',
  '--project-relationship',
  '--affected-artifacts',
  '--gate-impact',
  '--traceability-refs',
  '--project-note',
  '--track-id',
  '--track-name',
  '--track-type',
  '--lifecycle-model',
  '--track-relationship',
  '--track-traceability-refs',
  '--track-note',
  '--team-role',
  '--actor-id',
  '--actor-type',
  '--evidence',
  '--note',
  '--supersedes',
  '--execution-role',
  '--routing-decision',
  '--intent-id',
  '--intent-confidence',
  '--confirm-intent-track',
  '--execution-shape',
  '--id',
  '--title',
  '--description',
  '--owner',
  '--reason',
  '--severity',
]);

export const ACTIVE_TIERS: readonly string[] = ['personal', 'confidential', 'public'];
