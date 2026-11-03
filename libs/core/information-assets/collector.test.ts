import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeReadFile, safeWriteFile, safeRmSync } from '../secure-io.js';
import {
  collectInformationAsset,
  informationAssetCollectionStatePath,
  readInformationAssetObservation,
} from './collector.js';
import { gmailHistoryCollector } from './provider-gmail.js';
import {
  githubReviewCollector,
  jiraIssueCollector,
  jiraApprovalCollector,
} from './provider-code-work.js';
import type { InformationAssetLocation, InformationAssetObservation } from './types.js';

const root = 'active/shared/tmp/information-asset-collector-tests';
const location = (overrides: Partial<InformationAssetLocation> = {}): InformationAssetLocation => ({
  location_id: 'review-inbox',
  asset_type: 'code.review_request',
  scope: { tenant_slug: 'acme', organization_id: 'engineering' },
  binding_id: 'github-acme',
  service_id: 'github',
  collector_id: 'github.review_requests',
  selectors: { owner: 'acme', repo: 'app', enrich_reviews: false },
  tier: 'confidential',
  authoritative: true,
  freshness_seconds: 300,
  enabled: true,
  version: 1,
  updated_at: '2026-11-01T00:00:00Z',
  ...overrides,
});
function pull(number: number, revision = 'a') {
  return {
    number,
    updated_at: '2026-11-01T00:00:00Z',
    head: { sha: revision },
    requested_reviewers: [{ login: 'alice' }],
  };
}
afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('information asset durable collector', () => {
  it('persists a pending page before publishing and resumes only unaccepted events', async () => {
    const loc = location();
    const accepted: InformationAssetObservation[] = [];
    const serviceCall = vi.fn(async () => [pull(1), pull(2)]);
    const authorize = vi.fn(async () => loc);
    const first = await collectInformationAsset(loc, {
      rootDir: root,
      serviceCall,
      authorize,
      publish(event) {
        const state = JSON.parse(
          String(safeReadFile(informationAssetCollectionStatePath(loc, root)))
        );
        expect(state.pending.observations).toHaveLength(2);
        if (event.subject_id.endsWith('/2')) throw new Error('ledger unavailable');
        accepted.push(event);
      },
    });
    expect(first.status).toBe('failed');
    expect(accepted).toHaveLength(1);
    const resumed = await collectInformationAsset(loc, {
      rootDir: root,
      serviceCall,
      authorize,
      publish: (event) => {
        accepted.push(event);
      },
    });
    expect(resumed.status).toBe('complete');
    expect(serviceCall).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveLength(2);
    expect(readInformationAssetObservation(loc, accepted[0]!.event_id, root)?.subject_id).toBe(
      'acme/app/pull/1'
    );
  });
  it('holds after selector/binding changes or corrupt checkpoint bytes without calling a provider', async () => {
    const loc = location();
    const serviceCall = vi.fn(async () => []);
    await collectInformationAsset(loc, {
      rootDir: root,
      serviceCall,
      authorize: async () => loc,
      publish() {},
    });
    serviceCall.mockClear();
    const changed = location({ selectors: { owner: 'other', repo: 'app' } });
    expect(
      (
        await collectInformationAsset(changed, {
          rootDir: root,
          serviceCall,
          authorize: async () => changed,
          publish() {},
        })
      ).status
    ).toBe('failed');
    safeWriteFile(informationAssetCollectionStatePath(loc, root), '{broken');
    expect(
      (
        await collectInformationAsset(loc, {
          rootDir: root,
          serviceCall,
          authorize: async () => loc,
          publish() {},
        })
      ).status
    ).toBe('failed');
    expect(serviceCall).not.toHaveBeenCalled();
  });
  it('reports budget truncation, resumes the next page, and retains distinct revisions', async () => {
    const loc = location();
    const events: InformationAssetObservation[] = [];
    const serviceCall = vi.fn(async (request: { params: Record<string, unknown> }) =>
      (request.params.query as { page: number }).page === 1
        ? Array.from({ length: 100 }, (_, index) => pull(index + 1))
        : [pull(101)]
    );
    const deps = {
      rootDir: root,
      maxPages: 1,
      serviceCall,
      authorize: async () => loc,
      publish: (event: InformationAssetObservation) => {
        events.push(event);
      },
    };
    expect((await collectInformationAsset(loc, deps)).status).toBe('partial');
    expect((await collectInformationAsset(loc, deps)).status).toBe('complete');
    expect(events).toHaveLength(101);
    serviceCall.mockImplementation(async () => [pull(1, 'new-head')]);
    await collectInformationAsset(loc, deps);
    expect(events).toHaveLength(102);
    expect(events[0]!.subject_id).toBe(events[101]!.subject_id);
    expect(events[0]!.event_id).not.toBe(events[101]!.event_id);
  });
  it('serializes concurrent polls and durably deduplicates a previously accepted revision', async () => {
    const loc = location();
    const published: string[] = [];
    const deps = {
      rootDir: root,
      serviceCall: async () => [pull(1)],
      authorize: async () => loc,
      publish(event: InformationAssetObservation) {
        published.push(event.event_id);
      },
    };
    const results = await Promise.all([
      collectInformationAsset(loc, deps),
      collectInformationAsset(loc, deps),
    ]);
    expect(results.map((item) => item.status)).toEqual(['complete', 'complete']);
    expect(published).toHaveLength(1);
  });
  it('holds tampered pending observations without publishing them or advancing the cursor', async () => {
    const loc = location();
    await collectInformationAsset(loc, {
      rootDir: root,
      serviceCall: async () => [pull(1)],
      authorize: async () => loc,
      publish() {
        throw new Error('ledger unavailable');
      },
    });
    const file = informationAssetCollectionStatePath(loc, root);
    const state = JSON.parse(String(safeReadFile(file)));
    state.pending.observations[0].scope.tenant_slug = 'other';
    safeWriteFile(file, JSON.stringify(state));
    const publish = vi.fn();
    const result = await collectInformationAsset(loc, {
      rootDir: root,
      serviceCall: async () => [],
      authorize: async () => loc,
      publish,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('integrity');
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.parse(String(safeReadFile(file))).cursor).toEqual({});
  });
  it('keeps Gmail expired history in an explicit full-sync hold without resetting its checkpoint', async () => {
    const loc = location({
      location_id: 'mail-inbox',
      service_id: 'google-workspace',
      collector_id: 'gmail.history',
      asset_type: 'customer.request',
      selectors: {},
    });
    const deps = { rootDir: root, authorize: async () => loc, publish() {} };
    await collectInformationAsset(loc, {
      ...deps,
      serviceCall: async (request) =>
        request.action === 'gmail_profile_get' ? { historyId: '900' } : { messages: [] },
    });
    const result = await collectInformationAsset(loc, {
      ...deps,
      serviceCall: async () => {
        throw Object.assign(new Error('expired'), { status: 404 });
      },
    });
    expect(result.status).toBe('full_sync_required');
    const state = JSON.parse(String(safeReadFile(informationAssetCollectionStatePath(loc, root))));
    expect(state.cursor.checkpoint).toBe('900');
  });
  it('bounds all nested detail requests and retains the uncommitted cursor on a partial page', async () => {
    const loc = location({ selectors: { owner: 'acme', repo: 'app' } });
    const call = vi.fn(async (request) => (request.action === 'list_pulls' ? [pull(1)] : []));
    const result = await collectInformationAsset(loc, {
      rootDir: root,
      maxRequests: 1,
      serviceCall: call,
      authorize: async () => loc,
      publish() {},
    });
    expect(result.status).toBe('partial');
    expect(result.reason).toContain('request_budget_exhausted');
    expect(call).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(safeReadFile(informationAssetCollectionStatePath(loc, root)))).cursor
    ).toEqual({});
  });
  it('enforces an overall wall-clock deadline for stalled captures', async () => {
    const loc = location();
    const result = await collectInformationAsset(loc, {
      rootDir: root,
      wallClockMs: 5,
      serviceCall: () => new Promise(() => {}),
      authorize: async () => loc,
      publish() {},
    });
    expect(result.status).toBe('partial');
    expect(result.reason).toContain('wall_clock_budget_exhausted');
    expect(result.page_count).toBe(0);
  });
  it('rechecks registration before capture and refuses revoked grants or stale location bytes', async () => {
    const loc = location();
    const call = vi.fn(async () => []);
    const coverage = await collectInformationAsset(loc, {
      rootDir: root,
      serviceCall: call,
      authorize: async () => {
        throw new Error('grant revoked');
      },
      publish() {},
    });
    expect(coverage.status).toBe('failed');
    expect(call).not.toHaveBeenCalled();
  });
  it('times out a stalled read without advancing the checkpoint', async () => {
    const loc = location();
    const coverage = await collectInformationAsset(loc, {
      rootDir: root,
      timeoutMs: 5,
      serviceCall: () => new Promise(() => {}),
      authorize: async () => loc,
      publish() {},
    });
    expect(coverage.status).toBe('failed');
    expect(coverage.reason).toContain('timeout');
  });
});

describe('provider wire contracts', () => {
  it('uses GitHub vars/query nesting and keeps head revisions', async () => {
    const call = vi.fn(async () => [pull(1)]);
    const page = await githubReviewCollector.collect(location(), {}, call);
    expect(call).toHaveBeenCalledWith('list_pulls', {
      vars: { owner: 'acme', repo: 'app' },
      query: { state: 'open', sort: 'updated', direction: 'asc', page: 1, per_page: 100 },
    });
    expect(page.subjects[0]!.change_id).toContain(':a');
  });
  it('uses Jira enhanced opaque nextPageToken and dedicated JSM approvals', async () => {
    const loc = location({
      service_id: 'jira',
      selectors: { domain: 'acme', jql: 'assignee = currentUser()' },
    });
    const call = vi.fn(async () => ({
      issues: [{ key: 'OPS-1', fields: { updated: 'today', status: { name: 'Open' } } }],
      nextPageToken: 'opaque-token',
    }));
    const page = await jiraIssueCollector.collect(loc, {}, call);
    expect(page.next.page_token).toBe('opaque-token');
    const approvalCall = vi.fn(async () => ({
      values: [{ id: '12', finalDecision: 'pending' }],
      isLastPage: true,
    }));
    const approvals = await jiraApprovalCollector.collect(
      { ...loc, selectors: { domain: 'acme', issue_key: 'OPS-1' } },
      {},
      approvalCall
    );
    expect(approvals.subjects[0]!.data.approval_pending).toBe(true);
  });
  it('retains Gmail history checkpoint on expiry and nests gws params', async () => {
    const loc = location({ service_id: 'google-workspace', selectors: { label_id: 'INBOX' } });
    const call = vi.fn(async () => {
      throw Object.assign(new Error('expired'), { status: 404 });
    });
    await expect(
      gmailHistoryCollector.collect(loc, { checkpoint: '900', phase: 'history' }, call)
    ).rejects.toThrow('full_sync_required');
    expect(call).toHaveBeenCalledWith('gmail_history_list', {
      params: { userId: 'me', maxResults: 100, startHistoryId: '900', labelId: 'INBOX' },
    });
  });
  it('captures mailbox history baseline before full-list pagination', async () => {
    const loc = location({ service_id: 'google-workspace', selectors: {} });
    const call = vi.fn(async (action: string) =>
      action === 'gmail_profile_get'
        ? { historyId: '900' }
        : action === 'gmail_messages_list'
          ? { messages: [{ id: 'message-1' }], nextPageToken: 'next' }
          : { id: 'message-1', historyId: '901', snippet: 'hello' }
    );
    const page = await gmailHistoryCollector.collect(loc, {}, call);
    expect(page.complete).toBe(false);
    expect(page.next).toEqual({ checkpoint: '900', phase: 'initial', page_token: 'next' });
    expect(page.subjects[0]!.change_id).toBe('901');
  });
});
