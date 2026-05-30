import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearWorkCoordinationNamespace, clearWorkCoordinationStore, listCoordinationEvents, getWorkItem, setWorkCoordinationNamespace } from '../work-coordination.js';
import { importJiraIssueWithEvent, normalizeJiraIssue } from './jira-issues.js';

beforeEach(() => {
  setWorkCoordinationNamespace('work-jira-adapter-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

describe('jira issue adapter', () => {
  it('maps jira issue status and priority into work items', () => {
    const result = normalizeJiraIssue({
      key: 'PROJ-12',
      id: '10012',
      fields: {
        summary: 'Jira task',
        description: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Description body' }] }],
        },
        status: { name: 'In Progress' },
        priority: { name: 'High' },
        labels: ['jira', 'work'],
        assignee: { accountId: 'account-1', displayName: 'Alice' },
        project: { key: 'PROJ' },
        updated: '2026-05-30T00:00:00.000Z',
      },
    });

    expect(result.item.status).toBe('in_progress');
    expect(result.item.priority).toBe('high');
    expect(result.item.source).toBe('jira');
    expect(result.item.source_ref).toBe('PROJ-12');
    expect(result.item.assignee_user_id).toBe('account-1');
    expect(result.item.labels).toEqual(['jira', 'work']);
  });

  it('warns on unknown statuses and still imports the issue', () => {
    const result = importJiraIssueWithEvent({
      key: 'PROJ-99',
      fields: {
        summary: 'Mystery status',
        description: 'text',
        status: { name: 'Needs Review' },
        priority: { name: 'Normal' },
        labels: [],
        project: { key: 'PROJ' },
      },
    });

    expect(result.item.status).toBe('backlog');
    expect(result.warnings).toContain('unknown jira status: Needs Review');
    expect(listCoordinationEvents().some((event) => event.event_type === 'conflict_detected')).toBe(true);
    expect(getWorkItem(result.item.item_id)?.source_ref).toBe('PROJ-99');
  });
});
