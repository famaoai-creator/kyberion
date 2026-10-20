/** A workplace is a projection of canonical owners, never an authority or work ledger. */
import type { ResolvedWorkspaceSelection } from './workspace-scope.js';

export interface WorkspaceDotSummary {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'retired';
  goal: string;
  readiness: { ready: boolean; errors: string[] };
  budget: null | {
    throttle: 'normal' | 'soft' | 'hard';
    tokens: number;
    costUsd: number;
    scope: 'organization' | 'tenant' | 'system';
    costStatus?: 'unknown' | 'partial';
  };
}

export interface WorkspaceOverview {
  selection: ResolvedWorkspaceSelection;
  owner: { id: string; name: string; kind: ResolvedWorkspaceSelection['kind']; status?: string };
  goal: string | null;
  work: {
    items: { id: string; title: string; status: string }[];
    counts: { total: number; active: number; blocked: number };
  };
  library: {
    artifacts: { id: string; kind: string; name: string }[];
    inheritedFrom?: 'organization';
  };
  decisions: { approvals: { id: string; title: string; status: string }[] };
  autonomy: {
    dots: WorkspaceDotSummary[];
    pauseMeaning: 'future_wakeups_only';
    blockedReasons: string[];
  };
  capabilities: { canControlAutonomy: boolean };
  links?: { conversation: string; addResource?: string };
  /** Failed sources are unknown, never successful empty results. */
  unavailable: string[];
}

export function workspaceSelectionMatches(
  selection: ResolvedWorkspaceSelection,
  context: {
    tenant_slug?: string;
    organization_id?: string;
    project_id?: string;
    operation_id?: string;
  }
): boolean {
  return (['tenant_slug', 'organization_id', 'project_id', 'operation_id'] as const).every(
    (key) => !selection[key] || selection[key] === context[key]
  );
}
