import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  buildAnswer,
  buildAnswers,
  describeDraft,
  describeValue,
  emptyDraft,
  isPendingCustomer,
  issueMessageKey,
  keepAvailable,
  needsOurConfirmation,
  parseFragmentToken,
  pickLocale,
  screenForReason,
  sourceKey,
  type Draft,
  type ViewEntry,
} from './model.js';

const TOKEN = 'inv-0123456789abcdef.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

function entry(overrides: Partial<ViewEntry> = {}): ViewEntry {
  return {
    entry_id: 'nfr.auth',
    kind: 'choice',
    question: 'Which sign-in method?',
    options: [
      { label: 'Password', value: 'password' },
      { label: 'SSO', value: 'sso', impact: { cost: '+10%' } },
    ],
    requires_customer: false,
    current: { status: 'provisional', layer: 'ours', value: 'sso' },
    overridable: true,
    ...overrides,
  };
}

function draft(patch: Partial<Draft>): Draft {
  return { ...emptyDraft(), ...patch };
}

describe('fragment handling', () => {
  it('reads the token from #t=', () => {
    expect(parseFragmentToken(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(parseFragmentToken(`#x=1&t=${TOKEN}`)).toBe(TOKEN);
  });
  it('ignores missing, empty and malformed fragments', () => {
    expect(parseFragmentToken('')).toBeNull();
    expect(parseFragmentToken('#')).toBeNull();
    expect(parseFragmentToken('#t=')).toBeNull();
    expect(parseFragmentToken('#t=short')).toBeNull();
    expect(parseFragmentToken('#t=has space and <script>')).toBeNull();
    expect(parseFragmentToken(`?t=${TOKEN}`)).toBeNull();
  });
});

describe('language', () => {
  it('prefers the agenda locale, falls back to the browser', () => {
    expect(pickLocale('ja', ['en-US'])).toBe('ja');
    expect(pickLocale('en', ['ja'])).toBe('en');
    expect(pickLocale(undefined, ['fr-FR', 'ja-JP'])).toBe('ja');
    expect(pickLocale(undefined, ['fr'])).toBe('en');
    expect(pickLocale(undefined, undefined)).toBe('en');
  });
});

describe('current decision wording', () => {
  it('names the source in plain words', () => {
    expect(sourceKey({ status: 'provisional', layer: 'ours', value: 1 })).toBe('source_ours');
    expect(sourceKey({ status: 'provisional', layer: 'org_default', value: 1 })).toBe(
      'source_org_default'
    );
    expect(sourceKey({ status: 'confirmed', layer: 'customer', value: 1 })).toBe('source_customer');
    expect(sourceKey({ status: 'awaiting_customer', layer: 'none' })).toBe('source_awaiting');
  });
  it('shows an option label, never the raw value', () => {
    expect(describeValue(entry(), 'sso')).toEqual({ kind: 'text', text: 'SSO' });
    expect(describeValue(entry(), { x: 1 })).toEqual({ kind: 'none' });
    expect(describeValue(entry({ kind: 'approval' }), { approved: true })).toEqual({
      kind: 'approved',
    });
    expect(describeValue(entry({ kind: 'hearing' }), 'free words')).toEqual({
      kind: 'text',
      text: 'free words',
    });
  });
  it('offers keep only where something readable is in force', () => {
    expect(keepAvailable(entry())).toBe(true);
    expect(keepAvailable(entry({ current: { status: 'undecided', layer: 'none' } }))).toBe(false);
  });
});

describe('answer building', () => {
  it('option / keep / comment', () => {
    expect(buildAnswer(entry(), draft({ choice: 'option', optionIndex: 0 }))).toEqual({
      answer: { entry_id: 'nfr.auth', choice: 'option', value: 'password' },
    });
    expect(buildAnswer(entry(), draft({ choice: 'keep', comment: ' fine ' }))).toEqual({
      answer: { entry_id: 'nfr.auth', choice: 'keep', comment: 'fine' },
    });
  });
  it('keep is refused when nothing is in force', () => {
    const none = entry({ current: { status: 'undecided', layer: 'none' } });
    expect(buildAnswer(none, draft({ choice: 'keep' }))).toEqual({ issue: 'selection_invalid' });
  });
  it('approval: approve, and request_changes needs a comment', () => {
    const approval = entry({ kind: 'approval', options: [] });
    expect(buildAnswer(approval, draft({ choice: 'approve' }))).toEqual({
      answer: { entry_id: 'nfr.auth', choice: 'approve' },
    });
    expect(buildAnswer(approval, draft({ choice: 'request_changes' }))).toEqual({
      issue: 'comment_required',
    });
    expect(buildAnswer(approval, draft({ choice: 'request_changes', comment: '  ' }))).toEqual({
      issue: 'comment_required',
    });
    expect(buildAnswer(approval, draft({ choice: 'request_changes', comment: 'fix X' }))).toEqual({
      answer: { entry_id: 'nfr.auth', choice: 'request_changes', comment: 'fix X' },
    });
  });
  it('hearing: free text', () => {
    const hearing = entry({ kind: 'hearing', options: [] });
    expect(buildAnswer(hearing, draft({ text: '  our goal  ' }))).toEqual({
      answer: { entry_id: 'nfr.auth', choice: 'free_text', value: 'our goal' },
    });
    expect(buildAnswer(hearing, draft({}))).toBeNull();
  });
  it('ranking: ordered option values', () => {
    const ranking = entry({
      kind: 'ranking',
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ],
    });
    expect(buildAnswer(ranking, draft({ ranking: [2, 0] }))).toEqual({
      answer: { entry_id: 'nfr.auth', choice: 'option', value: ['c', 'a'] },
    });
    expect(buildAnswer(ranking, draft({ ranking: [9] }))).toEqual({ issue: 'selection_invalid' });
  });
  it('a comment alone is a note for our team', () => {
    expect(buildAnswer(entry(), draft({ comment: 'call me' }))).toEqual({
      answer: { entry_id: 'nfr.auth', choice: 'free_text', comment: 'call me' },
    });
  });
  it('collects answers and issues across items, skipping untouched ones', () => {
    const entries = [
      entry({ entry_id: 'a' }),
      entry({ entry_id: 'b', kind: 'approval', options: [] }),
      entry({ entry_id: 'c' }),
    ];
    const drafts = new Map<string, Draft>([
      ['a', draft({ choice: 'option', optionIndex: 1 })],
      ['b', draft({ choice: 'request_changes' })],
    ]);
    const built = buildAnswers(entries, drafts);
    expect(built.answers.map((answer) => answer.entry_id)).toEqual(['a']);
    expect(built.issues).toEqual([{ entry_id: 'b', issue: 'comment_required' }]);
  });
});

describe('failure screens', () => {
  it('maps reason codes to plain screens', () => {
    expect(screenForReason('expired')).toBe('expired');
    expect(screenForReason('revoked')).toBe('revoked');
    expect(screenForReason('invalid_link')).toBe('invalid_link');
    expect(screenForReason('updating')).toBe('updating');
    expect(screenForReason('stale_version')).toBe('stale');
    expect(screenForReason('something_internal')).toBe('unavailable');
    expect(screenForReason(undefined)).toBe('unavailable');
  });
});

describe('provisional vs confirmed', () => {
  it('a customer answer awaiting our confirmation is not shown as a decision', () => {
    const pending = { status: 'provisional', layer: 'customer', value: 1 };
    expect(sourceKey(pending)).toBe('source_customer_pending');
    expect(
      sourceKey({
        status: 'confirmed',
        layer: 'customer',
        value: 1,
        awaiting_operator_confirmation: true,
      })
    ).toBe('source_customer_pending');
    expect(isPendingCustomer({ status: 'confirmed', layer: 'customer', value: 1 })).toBe(false);
    expect(isPendingCustomer({ status: 'provisional', layer: 'ours', value: 1 })).toBe(false);
  });
  it('awaiting_customer status reads as awaiting even with a stale value', () => {
    expect(sourceKey({ status: 'awaiting_customer', layer: 'ours', value: 1 })).toBe(
      'source_awaiting'
    );
  });
  it('knows when a submission needs our confirmation', () => {
    const entries = [
      entry({ entry_id: 'a', requires_customer: true }),
      entry({ entry_id: 'b', requires_customer: false }),
    ];
    expect(needsOurConfirmation(entries, [{ entry_id: 'a', choice: 'keep' }])).toBe(true);
    expect(needsOurConfirmation(entries, [{ entry_id: 'b', choice: 'keep' }])).toBe(false);
  });
});

describe('validation messages and approval drafts', () => {
  it('maps issues to vocabulary keys', () => {
    expect(issueMessageKey('comment_required')).toBe('comment_missing');
    expect(issueMessageKey('selection_invalid')).toBe('selection_invalid');
  });
  it('renders a draft as text, list or rows', () => {
    expect(describeDraft('Hello')).toEqual({ kind: 'text', text: 'Hello' });
    expect(describeDraft(['a', 'b', ' '])).toEqual({ kind: 'list', items: ['a', 'b'] });
    expect(describeDraft({ scope: 'web', n: 3, empty: '' })).toEqual({
      kind: 'pairs',
      pairs: [
        ['scope', 'web'],
        ['n', '3'],
      ],
    });
    expect(describeDraft(undefined)).toEqual({ kind: 'none' });
    expect(describeDraft('  ')).toEqual({ kind: 'none' });
    expect(describeDraft([])).toEqual({ kind: 'none' });
  });
});

describe('vocabulary coverage', () => {
  const read = (relative: string): string =>
    safeReadFile(pathResolver.rootResolve(relative), { encoding: 'utf8' }) as string;
  const catalog = JSON.parse(
    read('knowledge/product/orchestration/user-facing-vocabulary.json')
  ) as { domains: Record<string, Record<string, Record<string, string>>> };
  const domain = catalog.domains.customer_room;

  function usedKeys(): Set<string> {
    const main = read('presence/displays/customer-room/src/app/main.ts');
    const model = read('presence/displays/customer-room/src/app/model.ts');
    const keys = new Set<string>();
    for (const match of main.matchAll(/(?<![\w.])t\(/gu)) {
      let depth = 1;
      let end = (match.index ?? 0) + match[0].length;
      while (depth > 0 && end < main.length) {
        if (main[end] === '(') depth += 1;
        if (main[end] === ')') depth -= 1;
        end += 1;
      }
      const args = main.slice((match.index ?? 0) + match[0].length, end - 1);
      // Literals compared with === / !== are conditions, not keys.
      for (const lit of args.matchAll(/(?<!===\s)(?<!!==\s)'([a-z][a-z0-9_]*)'/gu)) {
        keys.add(lit[1]);
      }
    }
    for (const lit of main.matchAll(/'((?:state|impact)_[a-z_]+)'/gu)) keys.add(lit[1]);
    for (const lit of model.matchAll(/'(source_[a-z_]+|comment_missing)'/gu)) keys.add(lit[1]);
    for (const lit of main.matchAll(
      /'(current_line[a-z_]*|review_lead_[a-z]+|receipt_[a-z]+|reload|retry_action)'/gu
    )) {
      keys.add(lit[1]);
    }
    return keys;
  }

  it('every key the page uses exists in en and ja', () => {
    const keys = usedKeys();
    expect(keys.size).toBeGreaterThan(40);
    for (const key of keys) {
      expect(domain[key]?.en, `${key} en`).toBeTruthy();
      expect(domain[key]?.ja, `${key} ja`).toBeTruthy();
    }
  });
  it('has no unused keys', () => {
    const keys = usedKeys();
    const unused = Object.keys(domain).filter((key) => !keys.has(key));
    expect(unused).toEqual([]);
  });
});
