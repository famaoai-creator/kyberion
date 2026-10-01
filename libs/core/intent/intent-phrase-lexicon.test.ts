import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { getFoundationIo } from '../foundation/io.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  compileIntentPhraseLexicon,
  captureIntentPhrase,
  findIntentPhrase,
  getIntentPhraseMatcher,
  INTENT_PHRASE_LEXICON_RECHECK_MS,
  intentPhraseFlags,
  intentPhraseSource,
  loadIntentPhraseLexicon,
  matchesIntentPhrase,
  resetIntentPhraseLexiconCache,
  type IntentPhraseLexicon,
} from './intent-phrase-lexicon.js';

interface ParityFixture {
  concepts: Record<
    string,
    { old_regex: string; sites: string[]; match: string[]; no_match: string[] }
  >;
}

/**
 * Captured from the pre-lexicon regex literals (IT-01) before the call sites
 * were migrated; `match` / `no_match` record the old regex's decision.
 */
const parity = JSON.parse(
  safeReadFile(pathResolver.rootResolve('tests/fixtures/intent-phrase-parity.json'), {
    encoding: 'utf8',
  }) as string
) as ParityFixture;

/** Files whose intent regex literals were migrated to lexicon concept ids. */
const MIGRATED_SOURCES = [
  'libs/core/browser/browser-conversation-session.ts',
  'libs/core/contextual-intent-frame.ts',
  'libs/core/execution-brief.ts',
  'libs/core/guided-coordination-brief.ts',
  'libs/core/intent/intent-contract.ts',
  'libs/core/intent/intent-resolution.ts',
  'libs/core/knowledge/procedure-self-repair.ts',
  'libs/core/mission/mission-lifecycle.ts',
  'libs/core/mission/mission-team-brief-utils.ts',
  'libs/core/organization/organization-operating-model-persistence.ts',
  'libs/core/project/project-registry.ts',
  'libs/core/task/task-session.ts',
];

const TMP_ROOT = pathResolver.sharedTmp('intent-phrase-lexicon-tests');

afterAll(() => {
  safeRmSync(TMP_ROOT, { recursive: true, force: true });
  resetIntentPhraseLexiconCache();
});

function cloneGovernedLexicon(): IntentPhraseLexicon {
  return structuredClone(loadIntentPhraseLexicon());
}

describe('intent phrase lexicon — parity with the migrated regex literals', () => {
  const lexicon = loadIntentPhraseLexicon();

  it('covers exactly the concepts captured in the parity fixture', () => {
    expect(Object.keys(lexicon.concepts).sort()).toEqual(Object.keys(parity.concepts).sort());
  });

  for (const [conceptId, cases] of Object.entries(parity.concepts)) {
    it(`${conceptId} decides like ${cases.old_regex}`, () => {
      expect(cases.match.length + cases.no_match.length).toBeGreaterThan(0);
      for (const text of cases.match) {
        expect(matchesIntentPhrase(text, conceptId), `${conceptId} should match ${text}`).toBe(
          true
        );
      }
      for (const text of cases.no_match) {
        expect(matchesIntentPhrase(text, conceptId), `${conceptId} should not match ${text}`).toBe(
          false
        );
      }
    });
  }

  it('extracts the same leftmost phrase as the old .match() literals', () => {
    expect(findIntentPhrase('kintoneで稟議を申請して', 'approval.system_name')).toBe('kintone');
    expect(findIntentPhrase('SAP workflow approval', 'approval.system_name')).toBe('SAP');
    expect(findIntentPhrase('稟議システムで申請', 'approval.system_name')).toBe('稟議システム');
    expect(findIntentPhrase('普通の依頼', 'approval.system_name')).toBeUndefined();
    expect(findIntentPhrase('REQ-1 を却下、その後承認', 'approval.decision_word')).toBe('却下');
    expect(findIntentPhrase('Please approve REQ-1234', 'approval.decision_word')).toBe('approve');
  });

  it('captures the first group of the first matching extraction pattern (quoted text first)', () => {
    const target = 'browser.target_text_extract';
    expect(captureIntentPhrase('左下の「保存」を押して', target)).toBe('保存');
    expect(captureIntentPhrase('送信ボタンを押して', target)).toBe('送信ボタン');
    expect(captureIntentPhrase('click "Save"', target)).toBe('Save');
    expect(captureIntentPhrase('hello world', target)).toBeUndefined();
    const input = 'browser.input_text_extract';
    expect(captureIntentPhrase('「abc」を入力して', input)).toBe('abc');
    expect(captureIntentPhrase('abcと入力', input)).toBe('abc');
    expect(captureIntentPhrase('type "abc" in the box', input)).toBeUndefined();
    expect(captureIntentPhrase('"abc" type', input)).toBe('abc');
    // locale filter narrows the patterns tried
    expect(captureIntentPhrase('"abc" type', input, { locales: ['ja'] })).toBeUndefined();
  });

  it('composes the slide-count unit like the old /(\\d+)\\s*(枚|slides?)/i literal', () => {
    const unit = 'presentation.slide_count_unit';
    const composed = new RegExp(`(\\d+)\\s*${intentPhraseSource(unit)}`, intentPhraseFlags(unit));
    const old = /(\d+)\s*(枚|slides?)/i;
    for (const text of ['10枚の資料', 'Create a 12 slide deck', '3 Slides', 'slides 4', '枚数']) {
      expect(text.match(composed)?.[1]).toBe(text.match(old)?.[1]);
    }
  });

  it('keeps whole-utterance and prefix anchors', () => {
    expect(matchesIntentPhrase('はい', 'browser.confirm_affirmative')).toBe(true);
    expect(matchesIntentPhrase('はい、そうです', 'browser.confirm_affirmative')).toBe(false);
    expect(matchesIntentPhrase('stop now', 'browser.control_command')).toBe(true);
    expect(matchesIntentPhrase('stopwatch', 'browser.control_command')).toBe(false);
    expect(matchesIntentPhrase('please stop', 'browser.control_command')).toBe(false);
  });

  it('references only concept ids that exist in the lexicon from migrated sources', () => {
    const referenced = new Set<string>();
    for (const relPath of MIGRATED_SOURCES) {
      const source = safeReadFile(pathResolver.rootResolve(relPath), {
        encoding: 'utf8',
      }) as string;
      for (const match of source.matchAll(
        /(?:matchesIntentPhrase|findIntentPhrase)\([^;]*?'([a-z_]+(?:\.[a-z_]+)+)'/g
      )) {
        referenced.add(match[1]);
      }
    }
    expect(referenced.size).toBeGreaterThan(80);
    for (const conceptId of referenced) {
      expect(lexicon.concepts[conceptId], `missing concept ${conceptId}`).toBeDefined();
    }
  });
});

describe('intent phrase lexicon — locales', () => {
  it('checks every locale by default and can be narrowed to one', () => {
    expect(matchesIntentPhrase('来週の会議', 'coordination.meeting_request')).toBe(true);
    expect(matchesIntentPhrase('conference call', 'coordination.meeting_request')).toBe(true);
    expect(
      matchesIntentPhrase('conference call', 'coordination.meeting_request', { locales: ['ja-JP'] })
    ).toBe(false);
    expect(
      matchesIntentPhrase('来週の会議', 'coordination.meeting_request', { locales: ['ja-JP'] })
    ).toBe(true);
    // language-neutral product names (`und`) always apply
    expect(
      matchesIntentPhrase('Zoomで話そう', 'coordination.meeting_request', { locales: ['ja'] })
    ).toBe(true);
  });

  it('picks up a new locale added in JSON without code edits', () => {
    const lexicon = cloneGovernedLexicon();
    lexicon.concepts['date_range.today'].locales.fr = { phrases: ["aujourd'hui"] };
    lexicon.concepts['booking_category.hotel'].locales.fr = { patterns: ['h[ôo]tel'] };
    const filePath = path.join(TMP_ROOT, 'lexicon-with-fr.json');
    safeMkdir(TMP_ROOT, { recursive: true });
    safeWriteFile(filePath, `${JSON.stringify(lexicon, null, 2)}\n`);

    const withFrench = getIntentPhraseMatcher(filePath);
    expect(withFrench.localesOf('date_range.today')).toContain('fr');
    expect(withFrench.matches("mon planning d'aujourd'hui", 'date_range.today')).toBe(true);
    expect(withFrench.matches('réserver un hôtel', 'booking_category.hotel')).toBe(true);
    expect(
      withFrench.matches("planning d'aujourd'hui", 'date_range.today', { locales: ['fr-FR'] })
    ).toBe(true);
    expect(withFrench.matches('今日の予定', 'date_range.today', { locales: ['fr-FR'] })).toBe(
      false
    );
    // the governed lexicon is untouched
    expect(matchesIntentPhrase("mon planning d'aujourd'hui", 'date_range.today')).toBe(false);
  });
});

describe('intent phrase lexicon — fail closed', () => {
  it('rejects unknown concept ids with an operator-visible reason', () => {
    expect(() => matchesIntentPhrase('x', 'no_such.concept')).toThrow(
      /Unknown intent phrase concept "no_such.concept"/
    );
  });

  it('rejects nested-quantifier patterns (ReDoS guard) and invalid patterns', () => {
    const matcher = compileIntentPhraseLexicon({
      version: 'test',
      concepts: {
        'test.redos': { description: 'bad', locales: { en: { patterns: ['(a+)+b'] } } },
        'test.invalid': { description: 'bad', locales: { en: { patterns: ['(unclosed'] } } },
      },
    });
    expect(() => matcher.matches('aaaa', 'test.redos')).toThrow(/nested quantifier/);
    expect(() => matcher.matches('x', 'test.invalid')).toThrow(/invalid pattern/);
  });

  it('rejects stateful flags at schema validation', () => {
    const lexicon = cloneGovernedLexicon();
    lexicon.default_flags = 'gi';
    const filePath = path.join(TMP_ROOT, 'lexicon-bad-flags.json');
    safeMkdir(TMP_ROOT, { recursive: true });
    safeWriteFile(filePath, `${JSON.stringify(lexicon, null, 2)}\n`);
    expect(() => loadIntentPhraseLexicon(filePath)).toThrow(
      /Invalid catalog intent-phrase-lexicon/
    );
  });

  it('compiles each concept once and stays stateless across calls', () => {
    const matcher = getIntentPhraseMatcher();
    const first = matcher.regExp('date_range.today');
    expect(matcher.regExp('date_range.today')).toBe(first);
    expect(first.flags).not.toMatch(/[gy]/);
    expect(matcher.matches('今日', 'date_range.today')).toBe(true);
    expect(matcher.matches('今日', 'date_range.today')).toBe(true);
  });
});

describe('intent phrase lexicon — hot-path caching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetIntentPhraseLexiconCache();
  });

  it('serves the compiled matcher without re-statting the catalog inside the recheck window', () => {
    const filePath = path.join(TMP_ROOT, 'lexicon-cache.json');
    safeMkdir(TMP_ROOT, { recursive: true });
    safeWriteFile(filePath, `${JSON.stringify(cloneGovernedLexicon(), null, 2)}\n`);
    resetIntentPhraseLexiconCache();

    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const stat = vi.spyOn(getFoundationIo(), 'stat');

    const first = getIntentPhraseMatcher(filePath);
    const loadsAfterFirst = stat.mock.calls.length;
    expect(loadsAfterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 50; i += 1) {
      expect(getIntentPhraseMatcher(filePath)).toBe(first);
      first.matches('今日', 'date_range.today');
    }
    expect(stat.mock.calls.length).toBe(loadsAfterFirst);

    // An edit inside the window is not seen yet ...
    const edited = cloneGovernedLexicon();
    edited.concepts['date_range.today'].locales.fr = { phrases: ["aujourd'hui"] };
    safeWriteFile(filePath, `${JSON.stringify(edited, null, 2)}\n`);
    const statsAfterEdit = stat.mock.calls.length;
    expect(getIntentPhraseMatcher(filePath).matches("aujourd'hui", 'date_range.today')).toBe(false);
    expect(stat.mock.calls.length).toBe(statsAfterEdit);

    // ... and is picked up once the window elapses (one re-check, new matcher).
    const statsBeforeRecheck = stat.mock.calls.length;
    now += INTENT_PHRASE_LEXICON_RECHECK_MS;
    const reloaded = getIntentPhraseMatcher(filePath);
    expect(stat.mock.calls.length).toBeGreaterThan(statsBeforeRecheck);
    expect(reloaded).not.toBe(first);
    expect(reloaded.matches("aujourd'hui", 'date_range.today')).toBe(true);
  });

  it('re-checks immediately after an explicit reset', () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    getIntentPhraseMatcher();
    const stat = vi.spyOn(getFoundationIo(), 'stat');
    getIntentPhraseMatcher();
    expect(stat).not.toHaveBeenCalled();
    resetIntentPhraseLexiconCache();
    getIntentPhraseMatcher();
    expect(stat).toHaveBeenCalled();
  });
});

describe('intent phrase lexicon — bounded matching time (ReDoS smoke)', () => {
  const ADVERSARIAL_INPUTS = [
    `${'a'.repeat(5000)}!`,
    `${'あ'.repeat(5000)}!`,
    `${' '.repeat(5000)}x`,
    `${'1'.repeat(5000)}.`,
    `${'「'.repeat(2500)}${'」'.repeat(2500)}`,
    `${'"'.repeat(5000)}`,
    `${'a '.repeat(2500)}!`,
    `${'use-case-'.repeat(600)}:`,
    `${'「a」を'.repeat(800)}`,
    `${'"a" '.repeat(1200)}`,
  ];

  it('runs every concept (match and capture) over adversarial inputs within a time budget', () => {
    const matcher = getIntentPhraseMatcher();
    let slowest = { conceptId: '', ms: 0 };
    const started = performance.now();
    for (const conceptId of matcher.conceptIds) {
      for (const input of ADVERSARIAL_INPUTS) {
        const t0 = performance.now();
        matcher.matches(input, conceptId);
        matcher.capture(input, conceptId);
        const ms = performance.now() - t0;
        if (ms > slowest.ms) slowest = { conceptId, ms };
      }
    }
    const total = performance.now() - started;
    expect(slowest.ms, `slowest concept ${slowest.conceptId}`).toBeLessThan(250);
    expect(total).toBeLessThan(5000);
  });
});
