import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import type { OperatorHomeSummary } from '@agent/core/surface/operator-home-summary';
import { computeApprovalPresentedDigest } from '@agent/core/governance/approval-presentation';
import { settingsViewModel } from '../store/settings.js';
import { PanelView } from './panel-view.js';
import { OperatorCockpit } from './operator-cockpit.js';
import { I18nContext, makeI18n } from '../i18n.js';
vi.mock('@agent/core/surface/surface-url', () => ({
  resolveSurfaceBrowserUrl: () => 'http://127.0.0.1:3050/?token=private-query#old',
}));
vi.hoisted(() => {
  const guardedFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('data:application/octet-stream;base64,'))
      return Promise.resolve(new Response(Buffer.from(input.split(',')[1]!, 'base64')));
    return guardedFetch(input, init);
  });
});
afterEach(cleanup);
describe('TUI approval review handoff', () => {
  it('keeps many long pending requests compact in the cockpit and links only the first review', () => {
    const approval = {
      id: 'approval-fixture',
      title: 'Review external change with a very long title that should not expand the cockpit',
      summary: 'Reason for the pending change',
      expiresAt: '2026-10-28T10:00:00Z',
    } as OperatorHomeSummary['pendingApprovals'][number];
    const summary = {
      status: 'attention',
      statusLabel: 'Attention',
      statusDetail: 'Approval pending',
      counts: { pendingApprovals: 8, activeMissions: 0, blockedMissions: 0, unreadInbox: 0 },
      nextAction: { title: 'Review', reason: 'Human decision' },
      pendingApprovals: [
        approval,
        ...Array.from({ length: 7 }, (_, index) => ({
          ...approval,
          id: `hidden-${index}`,
          title: `Other approval ${index}`,
        })),
      ],
    } as unknown as OperatorHomeSummary;
    const ui = render(
      createElement(
        I18nContext.Provider,
        { value: makeI18n('en') },
        createElement(OperatorCockpit, { summary, loading: false })
      )
    );
    const frame = ui.lastFrame() || '';
    expect(frame).toContain('Review external change');
    expect(frame).not.toContain('Other approval');
    expect(frame).not.toContain(approval.summary);
    expect(frame).not.toContain(computeApprovalPresentedDigest(approval));
    expect(frame).toContain('2026-10-28');
    expect(frame.replace(/\s+/g, '')).toContain('#decide-approval-approval-fixture');
    expect(frame).not.toContain('private-query');
    expect(frame.split('\n').length).toBeLessThanOrEqual(16);
  });
  it('opens the full reason and digest only in the selected Settings approval detail', async () => {
    const approval = {
      id: 'approval-detail',
      title: 'Review change',
      summary: 'Full reason kept out of the cockpit',
      expiresAt: '2026-10-28T10:00:00Z',
    } as OperatorHomeSummary['pendingApprovals'][number];
    const vm = settingsViewModel(
      {
        reasoningMode: 'stub',
        customer: '-',
        profileRoot: '/fixture/profile',
        rootDir: '/fixture',
        approvals: [approval],
      },
      makeI18n('en')
    );
    expect(vm.rows?.[0]?.id).toBe('approval:approval-detail');
    expect(vm.rows?.[0]?.detail).toContainEqual({
      label: 'digest',
      value: computeApprovalPresentedDigest(approval),
    });
    const ui = render(
      createElement(
        I18nContext.Provider,
        { value: makeI18n('en') },
        createElement(PanelView, { vm, loading: false, isActive: true })
      )
    );
    expect(ui.lastFrame()).not.toContain(approval.summary);
    ui.stdin.write('\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain(approval.summary));
    const frame = (ui.lastFrame() || '').replace(/\s+/g, '');
    expect(frame).toContain(computeApprovalPresentedDigest(approval));
    expect(frame).toContain('#decide-approval-approval-detail');
    expect(frame).not.toContain('private-query');
  });
});
