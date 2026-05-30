import { appendCoordinationEvent, importExternalWorkItem, normalizeWorkItemLabels, type WorkItem } from '../work-coordination.js';

export interface JiraIssueLike {
  id?: string;
  key: string;
  fields: {
    summary: string;
    description?: string | null | { type?: string; version?: number; content?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
    status?: { name?: string | null };
    priority?: { name?: string | null };
    labels?: string[];
    assignee?: { accountId?: string | null; displayName?: string | null };
    project?: { key?: string | null; id?: string | null };
    updated?: string;
  };
}

export interface JiraIssueNormalizationResult {
  item: WorkItem;
  warnings: string[];
}

function coerceString(value: unknown): string {
  return String(value ?? '').trim();
}

function flattenDescription(description: JiraIssueLike['fields']['description']): string {
  if (typeof description === 'string') return description.trim();
  if (!description || typeof description !== 'object') return '';
  const content = description.content || [];
  const parts: string[] = [];
  for (const block of content) {
    for (const node of block.content || []) {
      if (node.type === 'text' && node.text) {
        parts.push(node.text);
      }
    }
  }
  return parts.join(' ').trim();
}

function mapStatus(statusName: string | undefined | null): WorkItem['status'] {
  const normalized = String(statusName || '').trim().toLowerCase();
  if (!normalized) return 'backlog';
  if (['done', 'resolved', 'closed', 'complete', 'completed'].includes(normalized)) return 'done';
  if (['in progress', 'in-progress', 'doing', 'development', 'implementing'].includes(normalized)) return 'in_progress';
  if (['review', 'in review', 'qa', 'testing', 'validation'].includes(normalized)) return 'review';
  if (['blocked', 'blocked by dependency', 'stuck'].includes(normalized)) return 'blocked';
  if (['ready', 'todo', 'to do', 'open', 'new', 'backlog'].includes(normalized)) return 'backlog';
  return 'backlog';
}

function inferPriority(priorityName: string | undefined | null): WorkItem['priority'] | undefined {
  const normalized = String(priorityName || '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (['highest', 'highest priority', 'urgent', 'critical'].includes(normalized)) return 'urgent';
  if (['high', 'important'].includes(normalized)) return 'high';
  if (['low', 'lowest'].includes(normalized)) return 'low';
  if (['normal', 'medium', 'moderate'].includes(normalized)) return 'normal';
  return undefined;
}

export function normalizeJiraIssue(issue: JiraIssueLike, projectId = issue.fields.project?.key || 'jira'): JiraIssueNormalizationResult {
  const warnings: string[] = [];
  const sourceRef = coerceString(issue.key);
  const statusName = issue.fields.status?.name;
  const mappedStatus = mapStatus(statusName);
  if (statusName && mappedStatus === 'backlog' && !['ready', 'todo', 'to do', 'open', 'new', 'backlog'].includes(String(statusName).trim().toLowerCase())) {
    warnings.push(`unknown jira status: ${statusName}`);
    appendCoordinationEvent({
      eventType: 'conflict_detected',
      itemId: sourceRef,
      note: `unknown jira status ${statusName}`,
      payload: { issue_key: issue.key, status: statusName },
    });
  }

  const assignee = issue.fields.assignee?.accountId || issue.fields.assignee?.displayName || undefined;
  const summary = coerceString(issue.fields.summary);
  const description = flattenDescription(issue.fields.description) || summary || 'Imported Jira issue';
  const item = importExternalWorkItem({
    source: 'jira',
    sourceRef,
    title: summary,
    description,
    status: mappedStatus,
    priority: inferPriority(issue.fields.priority?.name),
    projectId,
    assigneeUserId: assignee ? String(assignee).trim() : undefined,
    labels: normalizeWorkItemLabels(issue.fields.labels || []),
    metadata: {
      jira_key: issue.key,
      issue_id: issue.id || null,
      status_name: statusName || null,
      priority_name: issue.fields.priority?.name || null,
      updated: issue.fields.updated || null,
    },
  });

  return { item, warnings };
}

export function importJiraIssue(issue: JiraIssueLike, projectId?: string): JiraIssueNormalizationResult {
  return normalizeJiraIssue(issue, projectId);
}

export function importJiraIssueWithEvent(issue: JiraIssueLike, projectId?: string): JiraIssueNormalizationResult {
  const result = normalizeJiraIssue(issue, projectId);
  appendCoordinationEvent({
    eventType: 'external_sync_pulled',
    itemId: result.item.item_id,
    note: `imported Jira issue ${issue.key}`,
    payload: {
      source: 'jira',
      source_ref: issue.key,
      warnings: result.warnings,
    },
  });
  return result;
}
