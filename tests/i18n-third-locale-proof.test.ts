import { afterEach, describe, expect, it, vi } from 'vitest';
import { main as runCli } from '../scripts/cli.js';
import { t } from '@agent/core/t';
import { _resetLocaleModuleStateForTests } from '@agent/core/locale';
import { formatClarificationPacketConcise } from '@agent/core/intent-contract';
import { extractPlaceholderNames } from '@agent/core/message-format';
import {
  CHRONOS_LOCALE_STORAGE_KEY,
  chronosSpeechLocale,
  readStoredChronosLocale,
  resolveChronosLocale,
  setChronosLocalePreference,
  uxMessage,
  uxText,
} from '../presence/displays/chronos-mirror-v2/src/lib/ux-vocabulary.js';
import catalog from '../knowledge/product/orchestration/user-facing-vocabulary.json';

/**
 * I18N-07: proof-of-locale. `qps-ploc` was added to the catalog's
 * `required_locales` purely as data (`knowledge/product/orchestration/
 * user-facing-vocabulary.json` + `pnpm generate:vocabulary-types` +
 * `pnpm generate:pseudo-locale`, both generated-output ceremonies). These
 * tests prove the *resolution paths* actually carry a third locale end to
 * end, across the three surfaces named in the I18N-07 plan item: the CLI,
 * the core `t()` entry point (every namespace), and the chronos browser
 * path (its own, separate catalog-access implementation — the highest-risk
 * surface per the plan, since it duplicates locale-normalization logic for
 * bundle-safety reasons).
 */

const ENV_KEYS = ['KYBERION_LOCALE', 'KYBERION_UI_LOCALE', 'LANG'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  _resetLocaleModuleStateForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PSEUDO_LOCALE_BRACKET_OPEN = '⟦';
const PSEUDO_LOCALE_BRACKET_CLOSE = '⟧';

function isPseudoLocalized(text: string): boolean {
  return text.startsWith(PSEUDO_LOCALE_BRACKET_OPEN) && text.endsWith(PSEUDO_LOCALE_BRACKET_CLOSE);
}

describe('I18N-07 proof-of-locale: qps-ploc end to end', () => {
  describe('CLI surface: `pnpm kyberion help`', () => {
    it('renders pseudo-localized text for the ~87 cli namespace keys', async () => {
      // 0b8a1d9da routed every CLI write through an injected print sink
      // (`main(argv, print)`, default no-op) instead of console.log, so the
      // help output must be captured from that sink.
      const printed: string[] = [];

      await runCli(['help', '--locale', 'qps-ploc'], (value) => {
        printed.push(String(value));
      });

      const lines = printed;
      const decoratedLines = lines.filter((line) => line.includes(PSEUDO_LOCALE_BRACKET_OPEN));
      // The cli namespace has 87 keys (see the catalog); printHelp renders a
      // large fraction of them as standalone lines. A generous floor here
      // (not an exact count) keeps this test from being brittle against
      // wording/line-count changes while still failing hard if the whole
      // pathway regresses to plain English.
      expect(decoratedLines.length).toBeGreaterThan(30);

      // Cross-check against the catalog truth directly, rather than hardcoding
      // an expected decorated string: whatever `t()` resolves for a known cli
      // key in qps-ploc must appear verbatim in the rendered help output.
      const expectedUsageLine = t('cli:cli_help_usage', undefined, 'qps-ploc');
      expect(isPseudoLocalized(expectedUsageLine)).toBe(true);
      expect(lines).toContain(expectedUsageLine);
    });

    it('falls back to English for a locale this CLI does not have a hardcoded phrasing for (formatClarificationPacketConcise)', () => {
      // I18N-07 finding: `formatClarificationPacketConcise` in
      // libs/core/intent-contract.ts only has hand-written phrasing for
      // 'ja' (else it renders English) — its `options.locale` type was
      // widened from a hardcoded `'en' | 'ja'` union to `string` so this
      // compiles for any locale, but the *phrasing* itself is still
      // English-only for a third locale. That is expected (migrating this
      // formatter's phrasing is I18N-04 scope) — this test just pins that it
      // degrades gracefully (English) rather than throwing.
      const rendered = formatClarificationPacketConcise(
        { headline: 'h', summary: 's', questions: [] } as any,
        { locale: 'qps-ploc' }
      );
      expect(rendered).toContain('No missing inputs. Ready to proceed.');
    });
  });

  describe('core t(): every namespace resolves in qps-ploc with placeholders substituted', () => {
    it.each([
      ['chronos:chronos_agent_catalog_refreshed', { manifests: 3, runtimes: 5 }],
      ['cli:cli_more_questions', { count: 4 }],
      ['status:progress_working', undefined],
      ['error:error_title', undefined],
      ['question:question_provide', { input: 'a project id' }],
      ['common:empty_reply_body', undefined],
      ['concierge:concierge_escalation_hold_reply', undefined],
    ] as const)('%s resolves through qps-ploc', (key, params) => {
      const rendered = t(key as any, params as any, 'qps-ploc');
      expect(isPseudoLocalized(rendered)).toBe(true);

      const [namespace, bareKey] = key.split(':');
      const enTemplate = (catalog as any).domains[namespace][bareKey].en as string;
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          expect(rendered).toContain(String(value));
        }
      }
      // The placeholder-name set is unchanged between en and the rendered
      // qps-ploc output (params substituted, decoration/padding only touches
      // literal text) — same invariant check:catalogs enforces across the
      // catalog's stored en/qps-ploc pair before params are ever applied.
      expect(extractPlaceholderNames(rendered)).toEqual(
        extractPlaceholderNames(enTemplate).filter((name) => !(params && name in params))
      );
    });

    it('defaults to resolveLocale() when KYBERION_LOCALE=qps-ploc is set', () => {
      process.env.KYBERION_LOCALE = 'qps-ploc';
      delete process.env.KYBERION_UI_LOCALE;
      delete process.env.LANG;
      _resetLocaleModuleStateForTests();
      expect(isPseudoLocalized(t('cli:cli_readiness'))).toBe(true);
    });
  });

  describe('chronos browser path (ux-vocabulary.ts) — highest-risk surface per the I18N-07 plan', () => {
    it('uxText resolves qps-ploc when passed explicitly', () => {
      expect(isPseudoLocalized(uxText('chronos_active_missions', 'qps-ploc'))).toBe(true);
    });

    it('uxMessage resolves qps-ploc and substitutes placeholders', () => {
      const rendered = uxMessage(
        'chronos_agent_catalog_refreshed',
        { manifests: 7, runtimes: 2 },
        'fallback text should never be used here',
        'qps-ploc'
      );
      expect(isPseudoLocalized(rendered)).toBe(true);
      expect(rendered).toContain('7');
      expect(rendered).toContain('2');
    });

    it('chronosSpeechLocale falls back to English speech synthesis for the pseudo-locale (no dedicated TTS tag)', () => {
      // I18N-07 finding: speechLocales was `Record<SupportedLocale, string>`
      // (every locale required a literal speech tag), which broke `tsc` the
      // moment qps-ploc was added — widened to `Partial` so a locale with no
      // speech-synthesis tag degrades to English speech instead of failing
      // to compile. This pins that degradation.
      expect(chronosSpeechLocale('qps-ploc')).toBe('en-US');
    });

    function installFakeWindow(options: { stored?: string | null; language?: string }) {
      const store = new Map<string, string>();
      if (options.stored) store.set(CHRONOS_LOCALE_STORAGE_KEY, options.stored);
      const fakeWindow = {
        navigator: { language: options.language ?? 'en-US' },
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
        },
        dispatchEvent: () => true,
      };
      vi.stubGlobal('window', fakeWindow);
      vi.stubGlobal(
        'CustomEvent',
        class {
          type: string;
          detail: unknown;
          constructor(type: string, init?: { detail?: unknown }) {
            this.type = type;
            this.detail = init?.detail;
          }
        }
      );
      return store;
    }

    it('resolveChronosLocale honors a stored qps-ploc preference (I18N-07 fix: readStoredChronosLocale was hardcoded to ja/en)', () => {
      installFakeWindow({ stored: 'qps-ploc', language: 'en-US' });
      expect(readStoredChronosLocale()).toBe('qps-ploc');
      expect(resolveChronosLocale()).toBe('qps-ploc');
    });

    it('resolveChronosLocale honors qps-ploc via navigator.language when nothing is stored', () => {
      installFakeWindow({ stored: null, language: 'qps-ploc' });
      expect(resolveChronosLocale()).toBe('qps-ploc');
    });

    it('setChronosLocalePreference round-trips a qps-ploc choice through localStorage', () => {
      const store = installFakeWindow({ language: 'en-US' });
      setChronosLocalePreference('qps-ploc');
      expect(store.get(CHRONOS_LOCALE_STORAGE_KEY)).toBe('qps-ploc');
      expect(resolveChronosLocale()).toBe('qps-ploc');
    });
  });
});
