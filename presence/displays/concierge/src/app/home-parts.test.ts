import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { conciergeText } from '../lib/i18n';
import { composeHomeDashboard } from '../lib/home-dashboard';
import { parseNeedsYouSummary } from '../lib/home-view';
import {
  AgentsTile,
  CostTile,
  MissionsTile,
  NeedsYouTile,
  SetupChecklist,
  type HomeTranslate,
} from './home-parts';

const t: HomeTranslate = (key, params) => conciergeText(key, 'en', params);
const noop = () => {};
const render = (element: React.ReactElement) => renderToStaticMarkup(element);

describe('Needs you tile', () => {
  const summary = parseNeedsYouSummary({
    ok: true,
    total: 7,
    overdue: 2,
    oldestWaitingSince: '2026-11-01T00:00:00Z',
    byReason: { approval: 4, decision: 0, review: 2, knowledge: 0, clarification: 1, failure: 0 },
  })!;

  it('draws reasons as linked bars and the overdue count as the one red element', () => {
    const markup = render(
      React.createElement(NeedsYouTile, {
        t,
        bcp47: 'en',
        summary: { state: 'ready', data: summary },
        onRetry: noop,
      })
    );
    expect(markup).toContain('href="/inbox?reason=approval"');
    expect(markup).toContain('href="/inbox?reason=review"');
    expect(markup).toContain('href="/inbox?reason=clarification"');
    // Zero reasons are not drawn.
    expect(markup).not.toContain('reason=decision');
    expect(markup).toContain('class="kb-home__overdue" href="/inbox?overdue=1"');
    expect(markup).toContain('2 overdue');
    expect(markup).toContain('Oldest has waited since');
  });

  it('says a failed read is not zero, and a 429 is a busy server', () => {
    const busy = render(
      React.createElement(NeedsYouTile, {
        t,
        bcp47: 'en',
        summary: { state: 'error', failure: 'busy' },
        onRetry: noop,
      })
    );
    expect(busy).toContain('data-failure="busy"');
    expect(busy).toContain('too many requests');
    expect(busy).toContain('This is not zero');
    expect(busy).not.toContain('Nothing is waiting for you');
    expect(busy).not.toContain('kb-home__overdue');
  });

  it('shows a skeleton while loading, never a 0', () => {
    const loading = render(
      React.createElement(NeedsYouTile, {
        t,
        bcp47: 'en',
        summary: { state: 'loading' },
        onRetry: noop,
      })
    );
    expect(loading).toContain('kb-skeleton');
    expect(loading).not.toMatch(/>0</);
  });

  it('accepts the surface-operation envelope and rejects malformed bodies', () => {
    expect(
      parseNeedsYouSummary({ ok: true, data: { total: 1, overdue: 0, byReason: { review: 1 } } })
        ?.byReason.review
    ).toBe(1);
    expect(parseNeedsYouSummary({ ok: false })).toBeNull();
    expect(parseNeedsYouSummary({ ok: true, total: 'x' })).toBeNull();
  });
});

describe('dashboard tiles', () => {
  const home = composeHomeDashboard({
    now: Date.parse('2026-11-05T00:00:00Z'),
    failed: ['cost'],
    agentEntries: [
      { agent_id: 'a', status: 'in_progress' },
      { agent_id: 'b', status: 'review' },
    ],
  });

  it('renders agents as one stacked bar with an accessible summary and text counts', () => {
    const markup = render(
      React.createElement(AgentsTile, {
        t,
        home: { state: 'ready', data: home },
        onRetry: noop,
        bcp47: 'en',
      })
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('Agents by state: Working 1, Waiting for input 1, Error 0, Idle 0');
    expect(markup).toContain('data-state="working"');
  });

  it('marks an unavailable tile as such instead of showing an empty state', () => {
    const markup = render(
      React.createElement(CostTile, {
        t,
        home: { state: 'ready', data: home },
        onRetry: noop,
        bcp47: 'en',
      })
    );
    expect(markup).toContain('data-failure="unavailable"');
    expect(markup).not.toContain('No spending recorded yet');
  });

  it('gives an empty mission list what will appear and one action', () => {
    const markup = render(
      React.createElement(MissionsTile, {
        t,
        home: { state: 'ready', data: home },
        onRetry: noop,
        bcp47: 'en',
      })
    );
    expect(markup).toContain('No missions yet');
    expect(markup).toContain('Missions appear here');
  });

  it('hides the setup checklist once every organization is set up, and lists only open steps', () => {
    const done = render(
      React.createElement(SetupChecklist, {
        t,
        organizations: [{ tenant_slug: 'acme', steps: [], done: 4, total: 4, all_done: true }],
      })
    );
    expect(done).toBe('');
    const open = render(
      React.createElement(SetupChecklist, {
        t,
        organizations: [
          {
            tenant_slug: 'acme',
            done: 1,
            total: 2,
            all_done: false,
            steps: [
              { id: 'organization', done: true, href: '#settings-members' },
              { id: 'members', done: false, href: '#settings-invites' },
            ],
          },
        ],
      })
    );
    expect(open).toContain('href="/settings#settings-invites"');
    expect(open).not.toContain('#settings-members');
  });
});
