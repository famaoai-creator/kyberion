import { afterAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  compileIntentPhraseLexicon,
  findIntentPhrase,
  getIntentPhraseMatcher,
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
