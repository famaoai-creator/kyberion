import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import type { DecisionAgenda, DecisionSwitch, EffectiveDecision } from './model.js';
import {
  briefFieldsFromDecisionInput,
  dealNoteForSwitches,
  projectBriefInput,
  quoteCustomerText,
  readBriefInput,
  writeBriefInput,
} from './reflect.js';

const NOW = '2026-10-24T02:00:00.000Z';

const agenda: DecisionAgenda = {
  version: '1.0.0',
  agenda_id: 'agd-refl0001',
  tenant_slug: 'acme-corp',
  case_id: 'case-a',
  customer: 'acme',
  title: 'T',
  phase: 'p',
  revision: 1,
  locale: 'ja',
  entries: [
    {
      entry_id: 'perf',
      item: 'nfr.perf',
      key: 'nfr.perf',
      kind: 'choice',
      question: '性能目標は?',
      options: [
        { value: 'standard', label: '標準' },
        { value: 'fast', label: '高速' },
      ],
      requires_customer: false,
    },
    {
      entry_id: 'sec',
      item: 'nfr.sec',
      key: 'nfr.sec',
      kind: 'hearing',
      question: '安全性?',
      requires_customer: false,
    },
    {
      entry_id: 'bud',
      item: 'inc.bud',
      key: 'inc.bud',
      kind: 'hearing',
      question: '予算?',
      requires_customer: true,
    },
    {
      entry_id: 'pf',
      item: 'nfr.pf',
      key: 'nfr.pf',
      kind: 'hearing',
      question: '対象?',
      requires_customer: false,
    },
  ],
  status: 'sent',
  approval: { content_hash: 'a'.repeat(64), approved_at: NOW, approved_by: 'me' },
  created_at: NOW,
  updated_at: NOW,
};

const effective: EffectiveDecision[] = [
  {
    entry_id: 'perf',
    item: 'nfr.perf',
    key: 'nfr.perf',
    layer: 'customer',
    value: 'fast',
    decision_id: 'D-0003',
    status: 'confirmed',
    overridable: false,
  },
  {
    entry_id: 'sec',
    item: 'nfr.sec',
    key: 'nfr.sec',
    layer: 'ours',
    value: { level: 'basic' },
    decision_id: 'D-0004',
    status: 'provisional',
    overridable: true,
  },
  {
    entry_id: 'bud',
    item: 'inc.bud',
    key: 'inc.bud',
    layer: 'none',
    status: 'awaiting_customer',
    overridable: true,
  },
  {
    entry_id: 'pf',
    item: 'nfr.pf',
    key: 'nfr.pf',
    layer: 'none',
    status: 'undecided',
    overridable: true,
  },
];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) safeRmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('brief reflection', () => {
  it('projects effective decisions and open items', () => {
    const input = projectBriefInput(agenda, effective, NOW);
    expect(input.decisions).toHaveLength(4);
    expect(input.decisions[2]).not.toHaveProperty('value');
    expect(input.open_items).toEqual([
      { entry_id: 'bud', question: '予算?', status: 'awaiting_customer' },
      { entry_id: 'pf', question: '対象?', status: 'undecided' },
    ]);
    expect(input.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  for (const locale of ['ja', 'en'] as const) {
    it(`maps to mission-brief scope/openItems (${locale})`, () => {
      const fields = briefFieldsFromDecisionInput(
        projectBriefInput(agenda, effective, NOW),
        locale
      );
      const schemaPath = pathResolver.rootResolve(
        'knowledge/product/schemas/mission-brief.schema.json'
      );
      const brief = defineCatalog<unknown>({
        id: 'test-brief',
        path: schemaPath,
        schema: schemaPath,
      });
      expect(() => brief.validate(fields)).not.toThrow();
      expect(fields.scope.in).toHaveLength(2);
      expect(fields.scope.in[0]).toContain('fast');
      expect(fields.scope.in[1]).toContain('{"level":"basic"}');
      expect(fields.scope.in[1]).toMatch(locale === 'ja' ? /暫定/ : /Provisional/);
      expect(fields.scope.in[0]).not.toMatch(locale === 'ja' ? /暫定/ : /Provisional/);
      expect(fields.openItems).toHaveLength(2);
    });
  }

  it('round-trips brief input through the store', () => {
    const dir = path.join(pathResolver.sharedTmp(`cd-reflect-${randomUUID()}`));
    dirs.push(dir);
    const input = projectBriefInput(agenda, effective, NOW);
    expect(readBriefInput({ dir }, agenda.agenda_id)).toBeUndefined();
    writeBriefInput({ dir }, input);
    expect(readBriefInput({ dir }, agenda.agenda_id)).toEqual(input);
    expect(() => writeBriefInput({ dir }, { ...input, content_hash: 'bad' })).toThrow();
  });

  it('keeps one brief input per agenda of a case', () => {
    const dir = path.join(pathResolver.sharedTmp(`cd-reflect-${randomUUID()}`));
    dirs.push(dir);
    const first = projectBriefInput(agenda, effective, NOW);
    const other = projectBriefInput(
      { ...agenda, agenda_id: 'agd-refl0002' },
      effective.slice(0, 1),
      NOW
    );
    writeBriefInput({ dir }, first);
    writeBriefInput({ dir }, other);
    // The second agenda of the case does not overwrite the first one's input.
    expect(readBriefInput({ dir }, 'agd-refl0001')).toEqual(first);
    expect(readBriefInput({ dir }, 'agd-refl0002')).toEqual(other);
    expect(() => readBriefInput({ dir }, '../x')).toThrow(/AGENDA_ID_INVALID/u);
  });
});

describe('dealNoteForSwitches', () => {
  const change: DecisionSwitch = {
    version: '1.0.0',
    switch_id: 'sw-test0001',
    case_id: 'case-a',
    agenda_id: 'agd-refl0001',
    entry_id: 'perf',
    item: 'nfr.perf',
    key: 'nfr.perf',
    kind: 'value_changed',
    from: { layer: 'ours', value: 'standard' },
    to: { layer: 'customer', value: 'fast' },
    at: NOW,
  };

  it('describes a changed value with option labels', () => {
    expect(dealNoteForSwitches([change], agenda, 'ja')).toBe(
      'お客様の決定で「性能目標は?」が 標準 から 高速 に変わりました。'
    );
  });

  it('describes a confirmation and joins lines (en)', () => {
    const text = dealNoteForSwitches(
      [
        change,
        {
          ...change,
          kind: 'confirmed',
          entry_id: 'sec',
          from: { layer: 'ours' },
          to: { layer: 'customer', value: 'x' },
        },
      ],
      agenda,
      'en'
    );
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('The customer confirmed');
  });

  it('quotes customer-written text on one line, truncated and attributed', () => {
    const written = `line one\nline two\u202e\u0007 ${'x'.repeat(400)}`;
    const text = dealNoteForSwitches(
      [
        {
          ...change,
          entry_id: 'sec',
          from: { layer: 'none' },
          to: { layer: 'customer', value: written },
        },
      ],
      agenda,
      'en'
    );
    // One switch, one line: customer text cannot forge further note lines.
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toMatch(/[\u0000-\u001f\u202e]/u);
    expect(text).toContain('"line one line two');
    expect(text).toContain('(written by the customer)');
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(320);
    expect(quoteCustomerText('a\r\nb')).toBe('a b');
    // Approved option labels are ours, not customer text.
    expect(dealNoteForSwitches([change], agenda, 'en')).not.toContain('written by the customer');
  });

  it('phrases an operator confirmation of a customer decision', () => {
    const text = dealNoteForSwitches(
      [
        {
          ...change,
          kind: 'confirmed',
          from: { layer: 'customer', value: 'fast', decision_id: 'D-0003' },
          to: { layer: 'customer', value: 'fast', decision_id: 'D-0003' },
        },
      ],
      agenda,
      'ja'
    );
    expect(text).toBe('担当者がお客様の決定「性能目標は?」（高速）を確認しました。');
  });
});
