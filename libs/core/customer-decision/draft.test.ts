import { describe, expect, it } from 'vitest';
import { generateAgendaDraft } from './draft.js';
import type { DecisionAgenda } from './model.js';

const NOW = '2026-10-24T01:00:00.000Z';

function agenda(): DecisionAgenda {
  return {
    version: '1.0.0',
    agenda_id: 'agd-draft001',
    tenant_slug: 'acme-corp',
    case_id: 'case-a',
    customer: 'acme',
    title: 'T',
    phase: 'p',
    revision: 1,
    locale: 'en',
    entries: [
      {
        entry_id: 'perf',
        item: 'nfr.perf',
        key: 'nfr.perf',
        kind: 'choice',
        question: 'Performance?',
        options: [
          { value: 'standard', label: 'Standard' },
          { value: 'fast', label: 'Fast' },
        ],
        org_default: { value: 'standard', source: 'template:x' },
        requires_customer: false,
      },
      {
        entry_id: 'stories',
        item: 'inc.stories',
        key: 'inc.stories',
        kind: 'approval',
        question: 'Stories?',
        requires_customer: false,
      },
      {
        entry_id: 'budget',
        item: 'inc.budget',
        key: 'inc.budget',
        kind: 'choice',
        question: 'Budget?',
        options: [{ value: 'a', label: 'A' }],
        requires_customer: true,
      },
    ],
    status: 'draft',
    created_at: '2026-10-24T00:00:00.000Z',
    updated_at: '2026-10-24T00:00:00.000Z',
  };
}

const fake = (answer: string | Error, name = 'fake') => ({
  name,
  prompt: async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  },
});

describe('generateAgendaDraft', () => {
  it('applies valid proposals and keeps structure unchanged', async () => {
    const source = agenda();
    const answer = JSON.stringify({
      entries: [
        { entry_id: 'perf', our_decision: { value: 'fast', rationale: 'Interactive use.' } },
        {
          entry_id: 'stories',
          our_decision: { value: [{ as: 'user', want: 'x' }], rationale: 'From intent.' },
          background: 'Sharper background.',
        },
        { entry_id: 'budget', our_decision: { value: 'a' } },
      ],
    });
    const out = await generateAgendaDraft(source, {
      intentText: 'build a portal',
      now: NOW,
      backend: fake('```json\n' + answer + '\n```'),
    });
    expect(out.generated).toBe(true);
    const [perf, stories, budget] = out.agenda.entries;
    expect(perf.our_decision).toEqual({ value: 'fast', rationale: 'Interactive use.' });
    expect(stories.our_decision?.value).toEqual([{ as: 'user', want: 'x' }]);
    expect(stories.background).toBe('Sharper background.');
    expect(budget.our_decision).toBeUndefined();
    expect(out.notes.some((n) => n.includes('budget'))).toBe(true);
    expect(out.agenda.updated_at).toBe(NOW);
    expect(out.agenda.revision).toBe(1);
    expect(out.agenda.entries.map((e) => [e.entry_id, e.item, e.key, e.requires_customer])).toEqual(
      source.entries.map((e) => [e.entry_id, e.item, e.key, e.requires_customer])
    );
    expect(out.agenda.entries[0].options).toEqual(source.entries[0].options);
  });

  it('rejects a choice value outside the options and falls back to the org default', async () => {
    const out = await generateAgendaDraft(agenda(), {
      intentText: 'x',
      now: NOW,
      backend: fake(
        JSON.stringify({ entries: [{ entry_id: 'perf', our_decision: { value: 'warp' } }] })
      ),
    });
    expect(out.generated).toBe(false);
    expect(out.agenda.entries[0].our_decision).toEqual({
      value: 'standard',
      rationale: 'Organization default.',
    });
    expect(out.agenda.entries[1].our_decision).toBeUndefined();
    expect(out.notes.some((n) => n.includes('options'))).toBe(true);
  });

  it('drops unknown fields and unknown entries', async () => {
    const out = await generateAgendaDraft(agenda(), {
      intentText: 'x',
      now: NOW,
      backend: fake(
        JSON.stringify({
          entries: [
            {
              entry_id: 'perf',
              requires_customer: true,
              options: [],
              our_decision: { value: 'fast', decision_id: 'D-9999' },
            },
            { entry_id: 'ghost', our_decision: { value: 1 } },
          ],
        })
      ),
    });
    const perf = out.agenda.entries[0];
    expect(perf.our_decision).toEqual({ value: 'fast' });
    expect(perf.requires_customer).toBe(false);
    expect(perf.options).toHaveLength(2);
    expect(out.agenda.entries).toHaveLength(3);
  });

  it('falls back on invalid output, a throwing backend and the stub', async () => {
    for (const backend of [
      fake('not json'),
      fake(new Error('boom')),
      fake('{"entries":[]}', 'stub'),
    ]) {
      const out = await generateAgendaDraft(agenda(), { intentText: 'x', now: NOW, backend });
      expect(out.generated).toBe(false);
      expect(out.agenda.entries[0].our_decision?.value).toBe('standard');
      expect(out.agenda.entries[1].our_decision).toBeUndefined();
      expect(out.agenda.entries[2].our_decision).toBeUndefined();
      expect(out.notes.length).toBeGreaterThan(0);
    }
  });

  it('does not overwrite an existing our_decision', async () => {
    const source = agenda();
    source.entries[0].our_decision = { value: 'fast', rationale: 'mine' };
    const out = await generateAgendaDraft(source, {
      intentText: 'x',
      now: NOW,
      backend: fake(
        JSON.stringify({ entries: [{ entry_id: 'perf', our_decision: { value: 'standard' } }] })
      ),
    });
    expect(out.agenda.entries[0].our_decision).toEqual({ value: 'fast', rationale: 'mine' });
  });

  it('uses the ja rationale for a ja agenda fallback', async () => {
    const source = { ...agenda(), locale: 'ja' as const };
    const out = await generateAgendaDraft(source, {
      intentText: 'x',
      now: NOW,
      backend: fake('', 'stub'),
    });
    expect(out.agenda.entries[0].our_decision?.rationale).toBe('組織の既定値です。');
  });
});
