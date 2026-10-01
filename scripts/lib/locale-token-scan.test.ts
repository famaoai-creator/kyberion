import { describe, expect, it } from 'vitest';
import { isEngineColourScoped, scanFileForLocaleTokens } from './locale-token-scan.js';

const scan = (code: string, file = 'libs/core/example.ts') => scanFileForLocaleTokens(code, file);

describe('scanFileForLocaleTokens', () => {
  describe('intent_regex', () => {
    it('flags a Japanese regex literal used as a matcher', () => {
      expect(scan('const a = /会議|meeting/i.test(text);').counts.intent_regex).toBe(1);
      expect(scan('const m = text.match(/(.+?)を押して/);').counts.intent_regex).toBe(1);
      expect(scan('const m = /あ/.exec(text);').counts.intent_regex).toBe(1);
    });

    it('ignores ASCII regexes and Japanese regexes that are not matchers', () => {
      expect(scan('const a = /meeting/i.test(text);').counts.intent_regex).toBe(0);
      expect(scan("const s = text.replace(/会議/g, '');").counts.intent_regex).toBe(0);
    });

    it('honours i18n-exempt on the same or previous line, and skips the lexicon module', () => {
      const exempt = scan('// i18n-exempt: protocol keyword\nconst a = /会議/.test(text);');
      expect(exempt.counts.intent_regex).toBe(0);
      expect(exempt.exemptions).toBe(1);
      expect(
        scan('const a = /会議/.test(text);', 'libs/core/intent/intent-phrase-lexicon.ts').counts
          .intent_regex
      ).toBe(0);
    });
  });

  describe('locale_compare / locale_literal', () => {
    it('flags ad-hoc locale comparisons in either operand order', () => {
      const r = scan("if (locale === 'ja') {}\nif ('en' !== lang) {}\nif (x == 'ja') {}");
      expect(r.counts.locale_compare).toBe(3);
    });

    it('does not flag unrelated comparisons or switch labels', () => {
      expect(scan("if (kind === 'jar') {}").counts.locale_compare).toBe(0);
      expect(scan("if (locale === pickByLocale('ja')) {}").counts.locale_compare).toBe(0);
    });

    it('flags hardcoded BCP-47 literals outside the locale modules', () => {
      expect(scan("const tag = 'ja-JP'; const e = `en-US`;").counts.locale_literal).toBe(2);
      expect(
        scan("export const x = 'ja-JP';", 'libs/core/locale-normalize.ts').counts.locale_literal
      ).toBe(0);
      expect(scan("if (locale === 'ja') {}", 'libs/core/locale.ts').counts.locale_compare).toBe(0);
    });

    it('honours i18n-exempt', () => {
      const r = scan("const tag = 'ja-JP'; // i18n-exempt: Intl option required by the API");
      expect(r.counts.locale_literal).toBe(0);
      expect(r.exemptions).toBe(1);
    });
  });

  describe('engine_hex', () => {
    const engine = 'libs/core/media/native-pptx-engine/example.ts';

    it('flags raw colour literals inside engine directories only', () => {
      const code = "const a = '#1E3A5F'; const b = 'rgba(0,0,0,0.5)'; const c = `fill:#fff`;";
      expect(scan(code, engine).counts.engine_hex).toBe(3);
      expect(scan(code, 'libs/core/other.ts').counts.engine_hex).toBe(0);
    });

    it('ignores colour-looking text in comments and non-colour strings', () => {
      expect(scan("// #1E3A5F\nconst a = '#addendum';", engine).counts.engine_hex).toBe(0);
    });

    it('scopes the engine directories', () => {
      expect(isEngineColourScoped('libs/core/video/video-design-system.ts')).toBe(true);
      expect(isEngineColourScoped('libs/actuators/media-actuator/src/x.ts')).toBe(true);
      expect(isEngineColourScoped('libs/actuators/voice-actuator/src/x.ts')).toBe(false);
    });
  });

  it('skips non-TypeScript files', () => {
    expect(scan("var a = 'ja-JP';", 'static/app.js').counts.locale_literal).toBe(0);
  });
});
