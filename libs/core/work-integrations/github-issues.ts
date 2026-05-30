import { appendCoordinationEvent, importExternalWorkItem, normalizeWorkItemLabels, type WorkItem } from '../work-coordination.js';

export interface GitHubIssueLike {
  id: number | string;
  number?: number;
  title: string;
  body?: string | null;
  state?: 'open' | 'closed' | string;
  labels?: Array<string | { name?: string | null }>;
  assignees?: Array<string | { login?: string | null }>;
  repository_url?: string;
  html_url?: string;
  updated_at?: string;
  milestone?: { title?: string | null } | null;
  draft?: boolean;
  state_reason?: string | null;
}

export interface GitHubIssueNormalizationResult {
  item: WorkItem;
  warnings: string[];
}

function coerceString(value: unknown): string {
  return String(value ?? '').trim();
}

function readLabels(labels: GitHubIssueLike['labels']): string[] {
  return normalizeWorkItemLabels(
    (labels || []).map((label) => (typeof label === 'string' ? label : String(label?.name || ''))),
  );
}

function readAssignee(assignees: GitHubIssueLike['assignees']): string | undefined {
  if (!assignees || assignees.length === 0) return undefined;
  const first = assignees[0];
  const login = typeof first === 'string' ? first : first?.login;
  return login ? String(login).trim() : undefined;
}

function mapStatus(issue: GitHubIssueLike): 'backlog' | 'ready' | 'done' {
  if (String(issue.state || '').toLowerCase() === 'closed') return 'done';
  if (issue.draft) return 'backlog';
  return readAssignee(issue.assignees) ? 'ready' : 'backlog';
}

export function normalizeGitHubIssue(issue: GitHubIssueLike, projectId = 'github'): GitHubIssueNormalizationResult {
  const warnings: string[] = [];
  const sourceRef = coerceString(issue.number ?? issue.id);
  const assignee = readAssignee(issue.assignees);
  const body = coerceString(issue.body);
  const description = body || coerceString(issue.title) || 'Imported GitHub issue';
  if (!body) {
    warnings.push('github issue body was empty');
  }
  const item = importExternalWorkItem({
    source: 'github',
    sourceRef,
    title: coerceString(issue.title),
    description,
    status: mapStatus(issue),
    projectId,
    assigneeUserId: assignee,
    labels: readLabels(issue.labels),
    metadata: {
      repository_url: issue.repository_url,
      html_url: issue.html_url,
      updated_at: issue.updated_at,
      milestone: issue.milestone?.title || null,
      draft: Boolean(issue.draft),
      state_reason: issue.state_reason || null,
    },
  });

  return { item, warnings };
}

export function importGitHubIssue(issue: GitHubIssueLike, projectId = 'github'): GitHubIssueNormalizationResult {
  return normalizeGitHubIssue(issue, projectId);
}

export function importGitHubIssueWithEvent(issue: GitHubIssueLike, projectId = 'github'): GitHubIssueNormalizationResult {
  const result = normalizeGitHubIssue(issue, projectId);
  appendCoordinationEvent({
    eventType: 'external_sync_pulled',
    itemId: result.item.item_id,
    note: `imported GitHub issue ${coerceString(issue.number ?? issue.id)}`,
    payload: {
      source: 'github',
      source_ref: coerceString(issue.number ?? issue.id),
      warnings: result.warnings,
    },
  });
  return result;
}
