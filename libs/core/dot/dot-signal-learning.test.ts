import { expect, it, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { createApprovalRequest } from '../governance/approval-request-create.js';
import {
  hasRatifiedDigestPreference,
  requestDotSignalRoutingReview,
} from './dot-signal-learning.js';

vi.mock('../governance/approval-request-create.js', () => ({ createApprovalRequest: vi.fn() }));
vi.mock('../governance/approval-linked-usability.js', () => ({
  approvalUsabilityRefusal: () => undefined,
}));

it('requires authenticated approval bound to the same preference, probe and custody', () => {
  const charter = {
    dot_id: 'status-watch',
    status: 'active',
    scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
    goal: {
      signal_probes: [
        {
          signal: 'report',
          probe: { type: 'file', expect: 'exists', path: 'knowledge/public/report' },
        },
      ],
    },
    authority: { authority_role: 'worker' },
    runtime: {},
    attention: { triggers: [] },
    notification: {
      digest_cron: '0 9 * * *',
      signal_alerts: {
        mode: 'prepare',
        max_age_s: 7200,
        ratified_digest: { signal: 'report', approval_id: 'review' },
      },
    },
  } as DotCharter;
  requestDotSignalRoutingReview(charter, 'report', 'Daily digest is enough.', {
    actorId: 'member:requester',
    requestedBy: 'member:requester',
  });
  const request = vi.mocked(createApprovalRequest).mock.calls[0]![1];
  const approved = {
    ...request,
    ...request.draft,
    id: 'review',
    status: 'approved',
    decidedByType: 'human',
    authenticated: true,
  } as ApprovalRequestRecord;
  expect(hasRatifiedDigestPreference(charter, 'report', () => approved)).toBe(true);
  expect(
    hasRatifiedDigestPreference(charter, 'report', () => ({ ...approved, authenticated: false }))
  ).toBe(false);
  expect(
    hasRatifiedDigestPreference(charter, 'report', () => ({
      ...approved,
      decidedByType: 'ai_agent',
    }))
  ).toBe(false);
  expect(
    hasRatifiedDigestPreference(charter, 'report', () => ({
      ...approved,
      details: 'different feedback',
    }))
  ).toBe(false);
  expect(
    hasRatifiedDigestPreference(
      { ...charter, scope: { ...charter.scope, tenant_slug: 'tenant-b' } },
      'report',
      () => approved
    )
  ).toBe(false);
  expect(
    hasRatifiedDigestPreference(
      { ...charter, notification: { ...charter.notification, digest_cron: '0 10 * * *' } },
      'report',
      () => approved
    )
  ).toBe(false);
  expect(
    hasRatifiedDigestPreference(
      {
        ...charter,
        notification: { ...charter.notification, delivery_mode: 'live' },
      },
      'report',
      () => approved
    )
  ).toBe(false);
  expect(
    hasRatifiedDigestPreference(
      {
        ...charter,
        attention: { triggers: [{ kind: 'cron', cron: '0 9 * * *', timezone: 'Asia/Tokyo' }] },
      },
      'report',
      () => approved
    )
  ).toBe(false);
});
