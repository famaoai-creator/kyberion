import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../decision-ledger/model.js';
import { agendaContentHash } from './hash.js';
import type { DecisionAgenda } from './model.js';

/**
 * HR-01: tenant hearing templates (resolution order, isolation, inline text,
 * objective). The tenant store is stubbed per tenant here; the real paths are
 * covered by scripts/customer_decision.templates.boundary.test.ts.
 */
const tenantRecords = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock('./store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store.js')>()),
  readTenantTemplateRecord: (tenant: string, id: string) => tenantRecords.get(tenant)?.get(id),
  listTenantTemplateIds: (tenant: string) => [...(tenantRecords.get(tenant)?.keys() ?? [])].sort(),
}));

import {
  instantiateTemplate,
  listDecisionTemplates,
  loadDecisionTemplate,
  resolveDecisionTemplate,
  validateDecisionTemplate,
  type DecisionTemplate,
} from './template.js';

const NOW = '2026-11-13T00:00:00.000Z';
const base = {
  agendaId: 'agd-tenant0001',
  tenantSlug: 'tenant-a',
  caseId: 'case-a',
  customer: 'acme',
  now: NOW,
};

function tenantTemplate(overrides: Partial<DecisionTemplate> = {}): DecisionTemplate {
  return {
    version: '1.0.0',
    template_id: 'aidlc-inception',
    phase: 'tenant_onboarding',
    title: { ja: '導入ヒアリング', en: 'Onboarding hearing' },
    objective: {
      statement: { ja: '現場の業務フローに合うかを確かめる', en: 'Check the flow fits the work' },
      success_criteria: [{ ja: '主要な3業務の流れが確定している', en: 'Three core flows agreed' }],
    },
    entries: [
      {
        entry_id: 'import_mode',
        item: 'DATA',
        key: 'import.mode',
        kind: 'choice',
        question: { ja: 'CSV の取り込み方は？', en: 'How do you import CSV?' },
        background: { ja: '月末に一括で入れています', en: 'Bulk at month end' },
        options: [
          {
            value: 'bulk',
            label: { ja: '一括', en: 'Bulk' },
            impact: {
              cost: { ja: '変わらない', en: 'No change' },
              schedule: { ja: '変わらない', en: 'No change' },
              scope: { ja: '現状どおり', en: 'As today' },
            },
          },
        ],
        org_default: { value: 'bulk', source: 'template:aidlc-inception' },
        requires_customer: false,
      },
    ],
    ...overrides,
  };
}

function put(tenant: string, record: unknown, id = 'aidlc-inception'): void {
  const records = tenantRecords.get(tenant) ?? new Map<string, unknown>();
  records.set(id, record);
  tenantRecords.set(tenant, records);
}

beforeEach(() => tenantRecords.clear());

describe('tenant template resolution (HR-01)', () => {
  it("uses the tenant's own template of an id before the product one", () => {
    put('tenant-a', tenantTemplate());
    const { template, origin } = resolveDecisionTemplate('aidlc-inception', {
      tenantSlug: 'tenant-a',
    });
    expect(origin).toBe('tenant');
    expect(template.phase).toBe('tenant_onboarding');
  });

  it('falls back to the product template, and ignores tenants without a tenantSlug', () => {
    put('tenant-a', tenantTemplate());
    expect(resolveDecisionTemplate('aidlc-inception', { tenantSlug: 'tenant-b' }).origin).toBe(
      'product'
    );
    expect(resolveDecisionTemplate('aidlc-inception').origin).toBe('product');
    expect(loadDecisionTemplate('aidlc-inception').title_key).toBeDefined();
  });

  it("never serves one tenant's template to another (no shared cache)", () => {
    put('tenant-a', tenantTemplate());
    expect(loadDecisionTemplate('aidlc-inception', { tenantSlug: 'tenant-a' }).phase).toBe(
      'tenant_onboarding'
    );
    expect(loadDecisionTemplate('aidlc-inception', { tenantSlug: 'tenant-b' }).phase).not.toBe(
      'tenant_onboarding'
    );
    put('tenant-b', tenantTemplate({ phase: 'tenant_b_phase' }));
    expect(loadDecisionTemplate('aidlc-inception', { tenantSlug: 'tenant-b' }).phase).toBe(
      'tenant_b_phase'
    );
    expect(loadDecisionTemplate('aidlc-inception', { tenantSlug: 'tenant-a' }).phase).toBe(
      'tenant_onboarding'
    );
  });

  it('never lets a tenant shadow bolt-review', () => {
    put('tenant-a', tenantTemplate({ template_id: 'bolt-review' }), 'bolt-review');
    expect(resolveDecisionTemplate('bolt-review', { tenantSlug: 'tenant-a' }).origin).toBe(
      'product'
    );
    expect(
      listDecisionTemplates('tenant-a').find((row) => row.template_id === 'bolt-review')
    ).toEqual({ template_id: 'bolt-review', origin: 'product', shadows_product: false });
  });

  it('lists own templates first-class and marks the product ids they shadow', () => {
    put('tenant-a', tenantTemplate());
    put('tenant-a', tenantTemplate({ template_id: 'site-survey' }), 'site-survey');
    expect(listDecisionTemplates('tenant-a')).toEqual([
      { template_id: 'aidlc-inception', origin: 'tenant', shadows_product: true },
      { template_id: 'bolt-review', origin: 'product', shadows_product: false },
      { template_id: 'site-survey', origin: 'tenant', shadows_product: false },
    ]);
  });

  it('refuses a stored template whose id differs from its file', () => {
    put('tenant-a', tenantTemplate({ template_id: 'other' }));
    expect(() => loadDecisionTemplate('aidlc-inception', { tenantSlug: 'tenant-a' })).toThrow(
      /TEMPLATE_ID_MISMATCH/
    );
  });
});

describe('template schema text slots (HR-01)', () => {
  it('still accepts every product template unchanged', () => {
    for (const id of ['aidlc-inception', 'bolt-review'])
      expect(() => validateDecisionTemplate(loadDecisionTemplate(id), id)).not.toThrow();
  });

  it('accepts inline text', () => {
    expect(() => validateDecisionTemplate(tenantTemplate(), 'aidlc-inception')).not.toThrow();
  });

  it('refuses a slot with both forms or with neither', () => {
    const both = tenantTemplate();
    both.entries[0].question_key = 'customer_decision:purpose_success_question';
    expect(() => validateDecisionTemplate(both, 'aidlc-inception')).toThrow();
    const neither = tenantTemplate();
    delete neither.entries[0].question;
    expect(() => validateDecisionTemplate(neither, 'aidlc-inception')).toThrow();
    const noTitle = tenantTemplate();
    delete noTitle.title;
    expect(() => validateDecisionTemplate(noTitle, 'aidlc-inception')).toThrow();
    const emptyText = tenantTemplate({ title: {} });
    expect(() => validateDecisionTemplate(emptyText, 'aidlc-inception')).toThrow();
  });
});

describe('instantiating a tenant template (HR-01)', () => {
  it('resolves inline text and the objective in the agenda locale', () => {
    const agenda = instantiateTemplate(tenantTemplate(), { ...base, locale: 'ja' });
    expect(agenda.title).toBe('導入ヒアリング');
    expect(agenda.objective).toEqual({
      statement: '現場の業務フローに合うかを確かめる',
      success_criteria: ['主要な3業務の流れが確定している'],
    });
    expect(agenda.entries[0].question).toBe('CSV の取り込み方は？');
    expect(agenda.entries[0].options?.[0]).toEqual({
      value: 'bulk',
      label: '一括',
      impact: { cost: '変わらない', schedule: '変わらない', scope: '現状どおり' },
    });
  });

  it('refuses a locale the inline text lacks, naming the slot', () => {
    const jaOnly = tenantTemplate();
    jaOnly.entries[0].background = { ja: '月末に一括で入れています' };
    expect(() => instantiateTemplate(jaOnly, { ...base, locale: 'en' })).toThrow(
      /TEMPLATE_LOCALE_MISSING.*entries\.import_mode\.background.*en/
    );
  });

  it('copies no objective when the template sets none', () => {
    const { objective: _objective, ...rest } = tenantTemplate();
    void _objective;
    const agenda = instantiateTemplate(rest, { ...base, locale: 'en' });
    expect('objective' in agenda).toBe(false);
  });
});

describe('objective in the content hash (HR-01)', () => {
  /** The content hash as it was computed before HR-01. */
  function preHr01Hash(agenda: DecisionAgenda): string {
    const content = {
      title: agenda.title,
      ...(agenda.from !== undefined ? { from: agenda.from } : {}),
      ...(agenda.respond_by !== undefined ? { respond_by: agenda.respond_by } : {}),
      phase: agenda.phase,
      locale: agenda.locale,
      customer: agenda.customer,
      entries: agenda.entries,
    };
    return createHash('sha256').update(canonicalJson(content), 'utf8').digest('hex');
  }

  it('keeps the hash of an agenda without an objective', () => {
    const agenda = instantiateTemplate(loadDecisionTemplate('aidlc-inception'), {
      ...base,
      locale: 'en',
    });
    expect(agenda.objective).toBeUndefined();
    expect(agendaContentHash(agenda)).toBe(preHr01Hash(agenda));
  });

  it('binds the objective when set', () => {
    const agenda = instantiateTemplate(tenantTemplate(), { ...base, locale: 'en' });
    const { objective: _objective, ...without } = agenda;
    void _objective;
    expect(agendaContentHash(agenda)).not.toBe(agendaContentHash(without));
    expect(agendaContentHash({ ...agenda, objective: { statement: 'Something else' } })).not.toBe(
      agendaContentHash(agenda)
    );
  });
});
