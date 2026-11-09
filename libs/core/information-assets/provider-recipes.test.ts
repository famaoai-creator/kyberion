vi.mock('../governance/mandate-shadow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../governance/mandate-shadow.js')>()),
  loadMandateCatalog: () => ({
    version: '1',
    external_effect_patterns: [],
    mandates: [
      {
        id: 'information-fixture',
        title: 'Information fixture admission',
        work_type_patterns: ['information_asset.'],
        allowed_path_globs: ['active/organizations/confidential/acme/engineering/**'],
        max_risk_level: 3,
        expires_at: '2099-01-01T00:00:00Z',
        authority: {
          tenant_slug: 'acme',
          status: 'active',
          max_cost: 1,
          currency: 'USD',
          allowed_external_effects: [
            'google-workspace:gmail_reply',
            'github:resolve_review_thread',
            'jira:answer_request_approval',
            'jira:transition_issue',
            'jira:add_comment',
          ],
        },
      },
    ],
  }),
}));
import { describe, expect, it, vi } from 'vitest';
import { gmailHistoryCollector, gmailFollowupCollector } from './provider-gmail.js';
import {
  githubReviewCollector,
  jiraIssueCollector,
  jiraApprovalCollector,
} from './provider-code-work.js';
import {
  buildInformationAssetRecipeProposals,
  INFORMATION_ASSET_WORK_PIPELINE,
} from './recipes.js';
import type { InformationAssetLocation, InformationAssetObservation } from './types.js';
import type { CollectorSubject } from './provider.js';
import type { DotCharter } from '../dot/dot-charter.js';

const scope = { tenant_slug: 'acme', organization_id: 'engineering' };
const now = new Date('2026-11-02T00:00:00Z');
function location(
  service: string,
  collector: string,
  asset: string,
  selectors: InformationAssetLocation['selectors']
): InformationAssetLocation {
  return {
    location_id: 'source-' + service,
    asset_type: asset,
    scope,
    service_id: service,
    binding_id: service + '-acme',
    collector_id: collector,
    selectors,
    tier: 'confidential',
    authoritative: true,
    freshness_seconds: 300,
    enabled: true,
    version: 1,
    updated_at: now.toISOString(),
  };
}
function observation(
  loc: InformationAssetLocation,
  subject: CollectorSubject
): InformationAssetObservation {
  return {
    ...subject,
    scope,
    asset_type: loc.asset_type,
    location_id: loc.location_id,
    binding_id: loc.binding_id,
    service_id: loc.service_id,
    event_id: 'a'.repeat(64),
    content_sha256: 'b'.repeat(64),
    observed_at: now.toISOString(),
  };
}
const charter = {
  scope: { ...scope, tier: 'confidential' },
  authority: {
    allowed_pipelines: [INFORMATION_ASSET_WORK_PIPELINE],
    allowed_execution_shapes: ['pipeline', 'mission'],
    mission_mandate_refs: ['information-fixture'],
  },
} as unknown as DotCharter;
describe('real provider facts reach all twelve builtin intake recipes', () => {
  it('derives Gmail follow-up only when the latest thread message is old and sent', async () => {
    const loc = location('google-workspace', 'gmail.followups', 'customer.request', {
      reply_overdue_after_seconds: 86400,
    });
    const page = await gmailFollowupCollector.collect(
      loc,
      {},
      async (action) =>
        action === 'gmail_messages_list'
          ? { messages: [{ id: 'message-1', threadId: 'thread-1' }] }
          : {
              messages: [
                {
                  id: 'message-1',
                  historyId: '100',
                  internalDate: String(now.getTime() - 172800000),
                  labelIds: ['SENT'],
                },
              ],
            },
      now
    );
    expect(page.subjects).toHaveLength(1);
    expect(page.subjects[0]!.event_type).toBe('message.overdue');
    const answered = await gmailFollowupCollector.collect(
      loc,
      {},
      async (action) =>
        action === 'gmail_messages_list'
          ? { messages: [{ id: 'message-1', threadId: 'thread-1' }] }
          : {
              messages: [
                {
                  id: 'message-2',
                  historyId: '101',
                  internalDate: String(now.getTime()),
                  labelIds: ['INBOX'],
                },
              ],
            },
      now
    );
    expect(answered.subjects).toEqual([]);
  });
  it('normalizes wire facts into all twelve matching recipes without fixture-only synthetic flags', async () => {
    const results: InformationAssetObservation[] = [];
    const mail = location('google-workspace', 'gmail.history', 'customer.request', {});
    const mailPage = await gmailHistoryCollector.collect(
      mail,
      {},
      async (action) =>
        action === 'gmail_profile_get'
          ? { historyId: '100' }
          : action === 'gmail_messages_list'
            ? { messages: [{ id: 'message-1' }] }
            : {
                id: 'message-1',
                historyId: '100',
                snippet: 'Please investigate',
                labelIds: ['INBOX'],
              },
      now
    );
    results.push(...mailPage.subjects.map((subject) => observation(mail, subject)));
    const followup = { ...mail, collector_id: 'gmail.followups' };
    const followupPage = await gmailFollowupCollector.collect(
      followup,
      {},
      async (action) =>
        action === 'gmail_messages_list'
          ? { messages: [{ id: 'message-2', threadId: 'thread-2' }] }
          : {
              messages: [
                {
                  id: 'message-2',
                  historyId: '101',
                  internalDate: String(now.getTime() - 259200000),
                  labelIds: ['SENT'],
                },
              ],
            },
      now
    );
    results.push(...followupPage.subjects.map((subject) => observation(followup, subject)));
    const github = location('github', 'github.review_requests', 'code.review_request', {
      owner: 'acme',
      repo: 'app',
    });
    const githubPage = await githubReviewCollector.collect(
      github,
      {},
      async (action) => {
        switch (action) {
          case 'list_pulls':
            return [
              {
                number: 42,
                updated_at: '2026-11-01T00:00:00Z',
                head: { sha: 'head-2' },
                requested_reviewers: [{ login: 'alice' }],
              },
            ];
          case 'list_reviews':
            return [
              {
                id: 1,
                commit_id: 'head-1',
                submitted_at: '2026-10-31T00:00:00Z',
                user: { id: 1, login: 'alice' },
              },
            ];
          case 'get_commit_check_runs':
            return { check_runs: [{ id: 2, conclusion: 'failure' }] };
          case 'get_review_threads':
            return {
              data: {
                repository: {
                  pullRequest: {
                    headRefOid: 'head-2',
                    reviewThreads: {
                      nodes: [{ id: 'thread-1', isResolved: false, isOutdated: false }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            };
          default:
            throw new Error('unexpected action');
        }
      },
      now
    );
    expect(githubPage.subjects[0]!.data).toMatchObject({
      number: 42,
      head_sha: 'head-2',
      review_thread_id: 'thread-1',
      additional_commits: true,
      unresolved_review_count: 1,
      ci_failed: true,
    });
    results.push(...githubPage.subjects.map((subject) => observation(github, subject)));
    const jira = location('jira', 'jira.issues', 'workflow.approval_request', {
      domain: 'acme',
      jql: 'assignee = currentUser()',
    });
    const issuePage = await jiraIssueCollector.collect(
      jira,
      {},
      async () => ({
        issues: [
          {
            key: 'OPS-1',
            fields: {
              updated: '2026-11-01T00:00:00Z',
              status: { name: 'Waiting for information' },
              assignee: { accountId: 'alice' },
              duedate: '2026-10-30',
              resolution: null,
            },
          },
        ],
        isLast: true,
      }),
      now
    );
    expect(issuePage.subjects[0]!.data).toMatchObject({
      assignee: 'alice',
      status: 'Waiting for information',
      resolved: false,
    });
    results.push(...issuePage.subjects.map((subject) => observation(jira, subject)));
    const approval = {
      ...jira,
      collector_id: 'jira.approvals',
      selectors: { domain: 'acme', issue_key: 'OPS-1' },
    };
    const approvalPage = await jiraApprovalCollector.collect(
      approval,
      {},
      async () => ({ values: [{ id: 2, finalDecision: 'pending' }], isLastPage: true }),
      now
    );
    results.push(...approvalPage.subjects.map((subject) => observation(approval, subject)));
    const recipeIds = new Set(
      results.flatMap((item) =>
        buildInformationAssetRecipeProposals(item, charter).map(
          (proposal) => proposal.information_asset_work!.recipe_id
        )
      )
    );
    expect([...recipeIds].sort()).toEqual(
      [
        'email.morning_triage',
        'email.reply_preparation',
        'email.action_extraction',
        'email.overdue_reply',
        'github.review_request',
        'github.review_update',
        'github.unresolved_review',
        'github.ci_failure',
        'jira.assignment',
        'jira.approval_pending',
        'jira.overdue',
        'jira.waiting_information',
      ].sort()
    );
  });
  it('emits a new Jira revision when an unchanged issue crosses its due time', async () => {
    const jira = location('jira', 'jira.issues', 'workflow.approval_request', {
      domain: 'acme',
      jql: 'assignee = currentUser()',
    });
    const call = async () => ({
      issues: [
        {
          key: 'OPS-1',
          fields: { updated: '2026-11-01T00:00:00Z', duedate: '2026-11-02', resolution: null },
        },
      ],
      isLast: true,
    });
    const before = await jiraIssueCollector.collect(
      jira,
      {},
      call,
      new Date('2026-11-01T23:59:00Z')
    );
    const after = await jiraIssueCollector.collect(
      jira,
      {},
      call,
      new Date('2026-11-02T00:01:00Z')
    );
    expect(before.subjects[0]!.subject_id).toBe(after.subjects[0]!.subject_id);
    expect(before.subjects[0]!.change_id).not.toBe(after.subjects[0]!.change_id);
  });
});
