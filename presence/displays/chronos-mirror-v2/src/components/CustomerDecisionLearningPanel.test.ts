import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CustomerDecisionLearningView,
  customerDecisionCandidateStatus,
  customerDecisionLearningCommands,
} from './CustomerDecisionLearningPanel';
import { customerDecisionHrefs } from '../lib/customer-decision-navigation';
import type { CustomerDecisionLearningViewData } from '../lib/customer-decision-learning-response';
import type { CustomerDecisionViewState } from '../lib/customer-decision-view-client';

const SECRET = 'zzsecret';
const hrefs = customerDecisionHrefs('/', new URLSearchParams('tenant=acme'));

function learning(
  over: Partial<CustomerDecisionLearningViewData> = {}
): CustomerDecisionLearningViewData {
  return {
    version: '1.0.0',
    tenant_slug: 'acme',
    report_date: '2026-10-24',
    available_dates: ['2026-10-17', '2026-10-24'],
    generated_at: '2026-10-24T09:00:00.000Z',
    since: '2026-07-26T00:00:00.000Z',
    thresholds: {
      min_samples: 5,
      min_overturn_rate: 0.6,
      min_value_count: 3,
      min_change_requests: 3,
      min_change_request_rate: 0.3,
      min_questions: 3,
    },
    metrics: { cases: 3, agendas: 4, receipts: 9, switches: 7 },
    suggestions: [
      {
        item: 'DATA',
        key: 'retention.days',
        template_id: 'aidlc-inception',
        entry_id: 'retention',
        suggestion_key: 'change_org_default:aidlc-inception#retention',
        kind: 'change_org_default',
        evidence: { samples: 6, count: 5, rate: 0.833 },
        learning_id: 'cdl-0123456789abcdef',
        candidate: 'created',
        has_suggested_default: true,
      },
    ],
    overturns: [
      {
        item: 'DATA',
        key: 'retention.days',
        template_id: 'aidlc-inception',
        entry_id: 'retention',
        scope: 'template_entry',
        from_layer: 'org_default',
        decided: 6,
        overturned: 5,
        kept: 1,
        overturn_rate: 0.833,
        other_values: 1,
      },
    ],
    questions: [
      {
        item: 'NFR',
        key: 'auth.method',
        template_id: null,
        entry_id: null,
        agendas: 2,
        off_option: 3,
        comments: 1,
      },
    ],
    agenda_questions: [],
    change_requests: [
      {
        item: 'NFR',
        key: 'auth.method',
        template_id: null,
        entry_id: null,
        kind: 'choice',
        answers: 6,
        change_requests: 2,
        request_changes: 1,
        reject: 0,
        rate: 0.5,
      },
    ],
    ...over,
  };
}

const render = (
  state: CustomerDecisionViewState<CustomerDecisionLearningViewData>,
  locale: 'en' | 'ja' = 'en',
  candidates: Array<{ learning_id: string; title: string; status: string }> = []
) =>
  renderToStaticMarkup(
    createElement(CustomerDecisionLearningView, {
      state,
      tenant: 'acme',
      organizationId: 'acme',
      locale,
      hrefs,
      candidates,
      onRetry: () => undefined,
    })
  );

describe('CustomerDecisionLearningPanel (CD-12 drill-down)', () => {
  it('shows suggestions, evidence, candidates and the tables, never a default value', () => {
    // A padded source: the panel prints known fields only.
    const paddedSuggestion = { ...learning().suggestions[0], suggested_org_default: SECRET };
    const value = learning({ suggestions: [paddedSuggestion] });
    const html = render({ kind: 'ready', value });
    for (const text of [
      'Learning from customer decisions',
      'Change the default',
      'A default change is suggested. Review the candidate with pnpm organization learning transition.',
      '5 of 6 (83%)',
      'cdl-0123456789abcdef',
      'Queued now',
      'DATA / retention.days',
      'aidlc-inception#retention',
      'Where customers chose differently',
      'Entries that raised questions',
      'Entries with change requests',
      'pnpm organization learning transition --organization-id acme --tier confidential --tenant-slug acme --learning-id cdl-0123456789abcdef',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain(SECRET);
    // Report dates: the current one marked, the others linked.
    expect(html).toContain('<span aria-current="page">2026-10-24</span>');
    expect(html).toContain('href="/?tenant=acme&amp;cd_view=learning&amp;cd_date=2026-10-17"');
    expect(html).toContain('<span aria-current="page">Learning from customer decisions</span>');
  });

  it('renders Japanese labels', () => {
    const html = render({ kind: 'ready', value: learning() }, 'ja');
    expect(html).toContain('顧客の決定からの学習');
    expect(html).toContain('既定を変更');
    expect(html).toContain('6 件中 5 件 (83%)');
  });

  it("prefers the organization model's candidate status", () => {
    const [suggestion] = learning().suggestions;
    expect(customerDecisionCandidateStatus(suggestion, [], 'en').label).toBe('Queued now');
    expect(
      customerDecisionCandidateStatus(
        suggestion,
        [{ learning_id: suggestion.learning_id, title: 't', status: 'approved' }],
        'ja'
      ).label
    ).toBe('承認済み');
  });

  it('says when there is no report yet, naming the install command', () => {
    const html = render({
      kind: 'ready',
      value: learning({ report_date: null, generated_at: null, since: null, suggestions: [] }),
    });
    expect(html).toContain('No learning report yet');
    expect(html).toContain('customer-decision learning --tenant acme --install');
  });

  it.each([
    [{ kind: 'loading' }, 'Loading the details'],
    [{ kind: 'error', message: 'took too long' }, 'Try again'],
    [{ kind: 'forbidden', message: 'denied' }, 'You cannot see these customer decisions'],
    [
      { kind: 'not_found', message: 'There is no learning report for this date.' },
      'There is no learning report for this date.',
    ],
    [{ kind: 'not_built', message: 'x' }, 'pnpm build'],
  ] as const)('renders the %o state', (state, text) => {
    expect(render(state)).toContain(text);
    expect(render(state, 'ja')).toContain('顧客の決定からの学習');
  });

  it('points the transition command at a placeholder when nothing is suggested', () => {
    expect(
      customerDecisionLearningCommands('acme', 'acme', learning({ suggestions: [] }))[0]
    ).toContain('--learning-id <learning_id>');
  });
});
