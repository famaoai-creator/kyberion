import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearWorkCoordinationNamespace, clearWorkCoordinationStore, getWorkItem, setWorkCoordinationNamespace } from '../work-coordination.js';
import { importGitHubIssueWithEvent, normalizeGitHubIssue } from './github-issues.js';

beforeEach(() => {
  setWorkCoordinationNamespace('work-github-adapter-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

describe('github issue adapter', () => {
  it('imports open and closed issues into work items', () => {
    const openIssue = normalizeGitHubIssue({
      id: 123,
      number: 123,
      title: 'Open issue',
      body: 'Work item body',
      state: 'open',
      labels: ['coordination', { name: 'triage' }],
      assignees: [{ login: 'alice' }],
      repository_url: 'https://github.com/acme/repo',
      html_url: 'https://github.com/acme/repo/issues/123',
    });

    expect(openIssue.item.status).toBe('ready');
    expect(openIssue.item.source).toBe('github');
    expect(openIssue.item.source_ref).toBe('123');
    expect(openIssue.item.labels).toEqual(['coordination', 'triage']);
    expect(openIssue.item.assignee_user_id).toBe('alice');

    const closedIssue = normalizeGitHubIssue({
      id: 456,
      number: 456,
      title: 'Closed issue',
      body: '',
      state: 'closed',
      labels: [],
    });
    expect(closedIssue.item.status).toBe('done');
    expect(closedIssue.warnings).toContain('github issue body was empty');
  });

  it('emits an external sync event when importing', () => {
    const result = importGitHubIssueWithEvent({
      id: 777,
      number: 777,
      title: 'Imported issue',
      body: 'Hello',
      state: 'open',
      labels: [],
    });

    expect(getWorkItem(result.item.item_id)).toMatchObject({
      source: 'github',
      source_ref: '777',
    });
  });
});
