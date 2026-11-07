import { describe, expect, it } from 'vitest';
import { conciergeText, frontDeskText } from './i18n';
import {
  REQUESTS_INBOX_PATH,
  WORK_INVENTORY_STATUSES,
  artifactKindKey,
  parseWorkInventoryPanel,
  readableDeliveryTitle,
  selectedCompany,
  workInventoryPanelPath,
  REQUESTS_PATH,
  estimatedPercent,
  findRequestTarget,
  inboxStatusKey,
  needsInboxDecision,
  parseRequestDetail,
  parseRequestsPayload,
  requestHref,
  requestLinkHref,
  requestsApiPath,
  taskStateHintKey,
  taskStateKey,
  type RequestsPayload,
} from './requests-view';

const payload: RequestsPayload = {
  active: [
    {
      id: 'TS-1',
      title: 'Plan',
      now: 'x',
      status: 'executing',
      task_state: 'executing',
      correlation_id: 'req-1',
      percent: 65,
      progress_basis: 'phase_estimate',
      selected_default: true,
    },
    { id: 'TS-2', title: 'Blocked', now: 'x', status: 'blocked', task_state: 'blocked' },
  ],
  delivered: [
    { id: 'ART-1', title: 'Report', kind: 'txt', status: 'unread', can_verdict: true },
    { id: 'ART-2', title: 'Draft', kind: 'txt', status: 'delivered', can_verdict: false },
  ],
  done: [
    {
      id: 'TS-3',
      title: 'Done',
      kind: 'task_session',
      status: 'completed',
      correlation_id: 'req-3',
    },
  ],
  mirror_href: '',
};

describe('仕事 › 依頼 view helpers', () => {
  it('sends only the page narrowing hints; the selection hint goes to the server as is', () => {
    expect(requestsApiPath(new URLSearchParams('tab=requests&request=x&q=1'))).toBe(
      '/api/progress'
    );
    expect(
      requestsApiPath(new URLSearchParams('tenant=acme&organization_id=org-a&projectId=p-1'))
    ).toBe('/api/progress?tenant=acme&organizationId=org-a&projectId=p-1');
    expect(requestsApiPath(new URLSearchParams('tenant=personal'))).toBe(
      '/api/progress?tenant=personal'
    );
    expect(requestsApiPath(new URLSearchParams(''), 'a/b c')).toBe('/api/progress/a%2Fb%20c');
    expect(workInventoryPanelPath(new URLSearchParams('tenant=shared&tab=requests'))).toBe(
      '/api/work-inventory/candidates?tenant=shared'
    );
    // Outgoing links carry a company only, never the personal / system views.
    expect(selectedCompany(new URLSearchParams('tenant=acme'))).toBe('acme');
    expect(selectedCompany(new URLSearchParams('tenant=personal'))).toBeNull();
    expect(selectedCompany(new URLSearchParams('tenant=shared'))).toBeNull();
  });

  it('gives a delivery a readable title and its kind a label', () => {
    const label = (key: Parameters<typeof conciergeText>[0]) => conciergeText(key, 'ja');
    const file = (title: string, artifact_kind: string) =>
      readableDeliveryTitle({ title, artifact_kind, title_from_file: true }, label);
    expect(file('2026-10-24.json', 'report')).toBe('レポート 2026-10-24');
    expect(file('2026-10-24T09-00.md', 'markdown')).toBe('文書 2026-10-24');
    expect(file('weekly-summary.pdf', 'pdf')).toBe('weekly-summary');
    // Only a title the server marks as a file name is rewritten.
    expect(readableDeliveryTitle({ title: 'Q3 plan v2.1', artifact_kind: 'plan' }, label)).toBe(
      'Q3 plan v2.1'
    );
    expect(
      readableDeliveryTitle(
        { title: '2026-10-24.json', artifact_kind: 'report', title_from_file: false },
        label
      )
    ).toBe('2026-10-24.json');
    expect(artifactKindKey('pptx')).toBe('ia_work_requests_kind_deck');
    expect(artifactKindKey('security-scan')).toBe('ia_work_requests_kind_other');
    expect(artifactKindKey(undefined)).toBe('ia_work_requests_kind_other');
  });

  it('parses the work-inventory panel and drops malformed rows', () => {
    const panel = parseWorkInventoryPanel({
      ok: true,
      scoped: true,
      start_href: 'https://studio.example.test/ask?mode=hearing&scenario=work_inventory',
      operator_hint: false,
      counts: { confirmed: 2 },
      candidates: [
        {
          entry_id: 'E1',
          title: 'Report',
          score: 0.5,
          hours_per_month: 4,
          automatable_ratio: 0.8,
          status: 'confirmed',
        },
        { entry_id: 'E2', status: 'unknown-status' },
      ],
    });
    expect(panel?.scoped).toBe(true);
    expect(panel?.candidates.map((row) => row.entry_id)).toEqual(['E1']);
    expect(
      parseWorkInventoryPanel({
        ok: true,
        scoped: false,
        start_href: '/x',
        counts: {},
        candidates: [],
      })?.scoped
    ).toBe(false);
    expect(conciergeText('ia_work_requests_inventory_choose_company', 'ja')).not.toContain(
      'ia_work_requests'
    );
    expect(panel?.counts).toEqual({
      draft: 0,
      confirmed: 2,
      candidate: 0,
      promoted: 0,
      retired: 0,
    });
    expect(parseWorkInventoryPanel({ ok: true, candidates: [] })).toBeNull();
    for (const status of WORK_INVENTORY_STATUSES) {
      const key = `progress_work_inventory_status_${status}`;
      expect(frontDeskText(key as never, 'ja'), key).not.toContain(key);
    }
  });

  it('opens a request by id, then by its correlation, else the default active item', () => {
    expect(findRequestTarget(payload, 'ART-1')).toMatchObject({
      section: 'delivered',
      item: { id: 'ART-1' },
    });
    expect(findRequestTarget(payload, 'req-3')).toMatchObject({
      section: 'done',
      item: { id: 'TS-3' },
    });
    expect(findRequestTarget(payload, null)?.item.id).toBe('TS-1');
    expect(findRequestTarget(payload, 'req-unknown')).toBeNull();
    expect(findRequestTarget({ ...payload, active: [] }, null)).toBeNull();
  });

  it('adds request=<id> to a link that already has a query — one query string', () => {
    expect(requestLinkHref(REQUESTS_PATH, 'abc-1')).toBe('/work?tab=requests&request=abc-1');
    expect(requestLinkHref('/work?tab=requests&request=old#x', 'new id')).toBe(
      '/work?tab=requests&request=new+id'
    );
    expect(requestLinkHref('https://desk.example.test/work', 'a')).toBe(
      'https://desk.example.test/work?request=a'
    );
    expect(requestHref('/work', new URLSearchParams('tab=requests&tenant=acme'), 'TS-1')).toBe(
      '/work?tab=requests&tenant=acme&request=TS-1'
    );
    expect(requestHref('/work', new URLSearchParams('tab=requests&request=TS-1'), null)).toBe(
      '/work?tab=requests'
    );
  });

  it('links a pending decision to 受信箱 deliverable reviews and never offers one itself', () => {
    expect(REQUESTS_INBOX_PATH).toBe('/inbox?reason=review');
    expect(needsInboxDecision(payload.delivered[0])).toBe(true);
    expect(needsInboxDecision(payload.delivered[1])).toBe(false);
    expect(needsInboxDecision(payload.active[0])).toBe(false);
  });

  it('labels the percent as a phase estimate only when the read model says so', () => {
    expect(estimatedPercent(payload.active[0])).toBe(65);
    expect(estimatedPercent(payload.active[1])).toBeNull();
    expect(conciergeText('ia_work_requests_percent', 'en', { percent: 65 })).toMatch(
      /65%.*estimate/
    );
  });

  it('has copy for every recorded task state, hint and inbox status', () => {
    // A missing key renders as itself — what the checks below rule out.
    expect(frontDeskText('progress_task_state_nope' as never, 'ja')).toContain(
      'progress_task_state_nope'
    );
    for (const state of [
      'collecting_requirements',
      'awaiting_input',
      'awaiting_confirmation',
      'planning',
      'executing',
      'verifying',
      'paused',
      'blocked',
      'completed',
      'failed',
      'released',
      'unknown',
      undefined,
    ] as const) {
      for (const key of [taskStateKey(state), taskStateHintKey(state)]) {
        expect(frontDeskText(key, 'ja'), key).not.toContain(key);
      }
    }
    for (const key of [
      'ia_work_requests_kind_line',
      'ia_work_requests_kind_report',
      'ia_work_requests_kind_other',
    ] as const) {
      expect(conciergeText(key, 'ja'), key).not.toContain(key);
    }
    for (const status of ['unread', 'read', 'accepted', 'rejected', 'changes_requested'] as const) {
      const key = inboxStatusKey(status);
      expect(conciergeText(key, 'en'), key).not.toContain(key);
    }
  });

  it('rejects malformed payloads instead of rendering them', () => {
    expect(parseRequestsPayload({ ok: true, ...payload })).toMatchObject({ mirror_href: '' });
    expect(parseRequestsPayload({ ok: true, active: [{}], delivered: [], done: [] })).toBeNull();
    expect(parseRequestsPayload({ ok: false })).toBeNull();
    expect(parseRequestDetail({ ok: true, item: { requested: 'x', log: [] } })).toEqual({
      requested: 'x',
      log: [],
    });
    expect(parseRequestDetail({ ok: true, item: { requested: 'x' } })).toBeNull();
  });
});
