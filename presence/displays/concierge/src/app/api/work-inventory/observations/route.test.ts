import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const guard = vi.hoisted(() => vi.fn(() => null));
const defaultViewer = () => ({
  context: {
    role: 'localadmin' as const,
    tenantSlugs: 'all' as const,
    organizationIds: 'all' as const,
    projectIds: 'all' as const,
    tierAccess: ['confidential', 'public'] as Array<'confidential' | 'public'>,
    source: 'loopback' as const,
  },
});
const viewerResolution = vi.hoisted(() => ({ value: undefined as unknown }));
const mocks = vi.hoisted(() => ({
  resolveMember: vi.fn(),
  listSummaries: vi.fn(),
  loadSummary: vi.fn(),
  confirm: vi.fn(),
  discard: vi.fn(),
  attach: vi.fn(),
  listEntries: vi.fn(),
  loadEntry: vi.fn(),
  saveEntry: vi.fn(),
}));

vi.mock('../../../../lib/api-guard', () => ({ requireConciergeMutationAccess: guard }));
vi.mock('../../../../lib/viewer-context', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/viewer-context')>(
    '../../../../lib/viewer-context'
  );
  return {
    ...actual,
    resolveConciergeViewer: vi.fn(() => viewerResolution.value),
  };
});
vi.mock('../../../../lib/i18n', () => ({
  frontDeskText: vi.fn((key: string) => key),
  resolveConciergeLocale: vi.fn(() => 'en'),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/member-registry', () => ({
  resolveMemberByPrincipal: mocks.resolveMember,
}));
vi.mock('@agent/core/work-inventory', () => ({
  listWorkInventoryEntries: mocks.listEntries,
  loadWorkInventoryEntry: mocks.loadEntry,
  saveWorkInventoryEntry: mocks.saveEntry,
}));
vi.mock('@agent/core/work-inventory-observation', () => ({
  listObservationSummaries: mocks.listSummaries,
  loadObservationSummary: mocks.loadSummary,
  confirmObservationSummary: mocks.confirm,
  discardObservationSummary: mocks.discard,
  attachObservationToEntry: mocks.attach,
  observationDigestLine: vi.fn(() => '3 ops in Excel'),
}));

import { GET, POST } from './route.js';
import { WorkInventoryConsentError } from '@agent/core/work-inventory-consent';

function request(body?: unknown): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest;
}

const summary = {
  summary_id: 'WIO-20260101-abc123456789',
  member_id: 'member-a',
  status: 'confirmed',
  source: 'desktop_recording',
  apps: ['Excel'],
  hosts: [],
  step_count: 3,
  window: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:05:00.000Z' },
};

describe('concierge work-inventory observations route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guard.mockReturnValue(null);
    viewerResolution.value = defaultViewer();
  });

  it('anonymous viewers are rejected before any member lookup', () => {
    viewerResolution.value = {
      response: new Response(JSON.stringify({ ok: false, error: 'no viewer' }), { status: 401 }),
    };
    const response = GET(request());
    expect((response as Response).status).toBe(401);
    expect(mocks.resolveMember).not.toHaveBeenCalled();
  });

  it("returns only the resolved viewer's own summaries plus candidates in their own scope", async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.listSummaries.mockReturnValue([summary]);
    mocks.listEntries.mockReturnValue([{ entry_id: 'WI-1', title: 'Invoice entry' }]);

    const response = GET(request());
    const payload = await (response as Response).json();

    expect(payload.ok).toBe(true);
    expect(mocks.listSummaries).toHaveBeenCalledWith('member-a');
    expect(payload.summaries).toHaveLength(1);
    expect(payload.summaries[0].proposed_steps).toBeUndefined();
    expect(payload.candidate_entries).toEqual([{ entry_id: 'WI-1', title: 'Invoice entry' }]);
  });

  it('404s when the viewer has no member record yet', () => {
    mocks.resolveMember.mockReturnValue(null);
    const response = GET(request());
    expect((response as Response).status).toBe(404);
  });

  it('POST confirm always acts as the resolved viewer, ignoring any other id', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.confirm.mockReturnValue(summary);
    const response = await POST(request({ action: 'confirm', summary_id: summary.summary_id }));
    expect(response.status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith(
      'member-a',
      summary.summary_id,
      expect.objectContaining({ by: { kind: 'human', id: 'member-a' } })
    );
  });

  it("POST attach refuses an entry outside the viewer's resolved scope", async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.loadEntry.mockReturnValue(null); // not found within the viewer's own scope
    const response = await POST(
      request({ action: 'attach', summary_id: summary.summary_id, entry_id: 'WI-outside' })
    );
    expect(response.status).toBe(404);
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("POST attach loads the entry from the viewer's own scope and upserts it", async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    const entry = { entry_id: 'WI-1', title: 'Invoice entry', scope: {}, steps: [] };
    mocks.loadEntry.mockReturnValue(entry);
    mocks.loadSummary.mockReturnValue(summary);
    mocks.attach.mockReturnValue({ ...entry, status: 'confirmed' });
    mocks.saveEntry.mockImplementation((value: unknown) => value);

    const response = await POST(
      request({ action: 'attach', summary_id: summary.summary_id, entry_id: 'WI-1' })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.attach).toHaveBeenCalledWith(
      entry,
      summary,
      expect.objectContaining({ by: { kind: 'human', id: 'member-a' } })
    );
    expect(payload.entry.entry_id).toBe('WI-1');
  });

  it('POST discard maps a not_found domain error to 404', async () => {
    mocks.resolveMember.mockReturnValue({ member_id: 'member-a' });
    mocks.discard.mockImplementation(() => {
      throw new WorkInventoryConsentError('not_found', 'observation summary WIO-x not found');
    });
    const response = await POST(request({ action: 'discard', summary_id: 'WIO-x' }));
    expect(response.status).toBe(404);
  });
});
