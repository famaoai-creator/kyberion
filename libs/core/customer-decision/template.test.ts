import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import type { DecisionAgenda } from './model.js';
import { instantiateTemplate, loadDecisionTemplate } from './template.js';

const NOW = '2026-10-24T00:00:00.000Z';
const base = {
  agendaId: 'agd-tmpl0001',
  tenantSlug: 'acme-corp',
  caseId: 'case-a',
  customer: 'acme',
  now: NOW,
};

function agendaSchemaValidate(value: unknown): DecisionAgenda {
  const schema = pathResolver.rootResolve(
    'knowledge/product/schemas/customer-decision-agenda.schema.json'
  );
  return defineCatalog<DecisionAgenda>({ id: 'test-agenda', path: schema, schema }).validate(value);
}

describe('customer decision templates', () => {
  it('rejects unsafe template ids', () => {
    for (const id of ['../x', 'A', '', 'a/b', 'a.json'])
      expect(() => loadDecisionTemplate(id)).toThrow(/TEMPLATE_ID_INVALID/);
  });

  it('fails for a missing template', () => {
    expect(() => loadDecisionTemplate('no-such-template')).toThrow();
  });

  for (const locale of ['ja', 'en'] as const) {
    it(`instantiates aidlc-inception in ${locale}`, () => {
      const template = loadDecisionTemplate('aidlc-inception');
      const agenda = instantiateTemplate(template, { ...base, locale, dealId: 'deal-1' });
      expect(() => agendaSchemaValidate(agenda)).not.toThrow();
      expect(agenda.status).toBe('draft');
      expect(agenda.revision).toBe(1);
      expect(agenda.phase).toBe(template.phase);
      expect(agenda.deal_id).toBe('deal-1');
      expect(agenda.entries).toHaveLength(template.entries.length);
      for (const entry of agenda.entries) {
        expect(entry.our_decision).toBeUndefined();
        expect(entry.question).not.toMatch(/^customer_decision:/);
        expect(entry.background).not.toMatch(/^customer_decision:/);
      }
      const perf = agenda.entries.find((e) => e.entry_id === 'performance_target')!;
      expect(perf.options).toHaveLength(3);
      expect(perf.options![0].impact).toEqual({
        cost: expect.any(String),
        schedule: expect.any(String),
        scope: expect.any(String),
      });
      expect(perf.org_default).toEqual({ value: 'standard', source: 'template:aidlc-inception' });
      // The locales actually differ.
      const other = instantiateTemplate(template, {
        ...base,
        locale: locale === 'ja' ? 'en' : 'ja',
      });
      expect(other.title).not.toBe(agenda.title);
    });
  }

  it('uses a custom resolver and title', () => {
    const template = loadDecisionTemplate('aidlc-inception');
    const agenda = instantiateTemplate(template, {
      ...base,
      locale: 'en',
      title: 'Custom',
      resolveText: (key) => `T(${key})`,
    });
    expect(agenda.title).toBe('Custom');
    expect(agenda.entries[0].question).toBe(`T(${template.entries[0].question_key})`);
  });

  it('copies requires_customer and omits org_default when absent', () => {
    const template = loadDecisionTemplate('aidlc-inception');
    const agenda = instantiateTemplate(template, { ...base, locale: 'en' });
    template.entries.forEach((src, i) => {
      expect(agenda.entries[i].requires_customer).toBe(src.requires_customer);
      expect('org_default' in agenda.entries[i]).toBe(Boolean(src.org_default));
    });
  });
});
