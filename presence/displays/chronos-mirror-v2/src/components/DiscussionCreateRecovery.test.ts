import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DiscussionCreateRecovery } from './DiscussionCreateRecovery';
import type { DiscussionRecoveryState } from '../lib/discussion-create-recovery';

const pending: DiscussionRecoveryState = {
  phase: 'unconfirmed',
  confirmedRoomId: null,
  pending: [
    {
      version: 1,
      request_id: '7bf285c3-ab12-49bd-93b2-899885ebdd88',
      routing: { tenant: 'original-tenant', mission_id: 'original', scope_digest: 'a'.repeat(64) },
    },
  ],
};
const render = (state = pending, locale: 'en' | 'ja' = 'en') =>
  renderToStaticMarkup(
    createElement(DiscussionCreateRecovery, { state, locale, onCheck: vi.fn(), onOpen: vi.fn() })
  );
describe('create recovery static markup (no rendered-browser interaction claim)', () => {
  it('explains uncertainty and exposes only a read-only request check', () => {
    const html = render();
    expect(html).toContain('Check request');
    expect(html).toContain('may already have started');
    expect(html).toContain('never resends generation');
    expect(html).toContain('A timeout does not stop the backend');
    expect(html).toContain('Recent rooms are not proof');
    expect(html).toContain('not a global cross-tab exactly-once guarantee');
    expect(html).not.toContain('Open confirmed room');
    expect(html).not.toContain('disabled=');
  });
  it.each(['submitting', 'checking'] as const)('disables duplicate actions while %s', (phase) => {
    const html = render({ ...pending, phase });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
  });
  it('exposes a confirmed room only through an explicit open action', () => {
    const onOpen = vi.fn();
    const html = renderToStaticMarkup(
      createElement(DiscussionCreateRecovery, {
        state: { phase: 'created', pending: [], confirmedRoomId: 'room-a' },
        locale: 'en',
        onCheck: vi.fn(),
        onOpen,
      })
    );
    expect(html).toContain('Open confirmed room');
    expect(html).not.toContain('Check request');
    expect(onOpen).not.toHaveBeenCalled();
  });
  it('gives a safe storage failure explanation and explicit recheck without pending data', () => {
    const html = render({ phase: 'storage-error', pending: [], confirmedRoomId: null });
    expect(html).toContain('New rooms are disabled');
    expect(html).toContain('do not clear it to retry');
    expect(html).toContain('Check request');
  });
  it('only a durable rejection permits a fresh explicit request after setup is checked', () => {
    const html = render({ phase: 'rejected', pending: [], confirmedRoomId: null });
    expect(html).toContain('durably rejected before execution');
    expect(html).toContain('Recheck setup');
  });
  it('localizes recovery uncertainty and check action in Japanese', () => {
    const html = render(pending, 'ja');
    expect(html).toContain('実行が開始済みの可能性');
    expect(html).toContain('リクエストを確認');
    expect(html).toContain('生成を再送しません');
  });
});

it('renders an individual check action for every pending request', () => {
  const second = { ...pending.pending[0], request_id: '32376722-f606-4799-a683-e0486cd090e1' };
  const html = render({ ...pending, pending: [...pending.pending, second] });
  expect(html.match(/Check request/g)).toHaveLength(3); // one explanation and two actions
  expect(html).toContain(second.request_id);
  expect(html).toContain(pending.pending[0].request_id);
});
it('shows pre-submit resolving and failure states without implying a create was sent', () => {
  const resolving = render({ phase: 'resolving', pending: [], confirmedRoomId: null });
  expect(resolving).toContain('aria-busy="true"');
  expect(resolving).toContain('No room has been requested yet');
  const failed = render({ phase: 'context-error', pending: [], confirmedRoomId: null });
  expect(failed).toContain('No create request was sent or saved');
  expect(failed).not.toContain('Open confirmed room');
});
