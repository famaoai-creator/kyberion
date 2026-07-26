import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from './core.js';
import { resolveLocale } from './locale.js';
import { t } from './t.js';
import type { VocabularyKey } from './t.js';
import { _resetVocabularyCatalogCacheForTests } from './vocabulary-catalog.js';

afterEach(() => {
  _resetVocabularyCatalogCacheForTests();
  vi.restoreAllMocks();
});

describe('t() (I18N-02 type-safe rendering entry point)', () => {
  it('renders a qualified namespace:key lookup in the requested locale', () => {
    expect(t('chronos:chronos_jump_to_section', undefined, 'en')).toBe('Jump to section');
    expect(t('chronos:chronos_jump_to_section', undefined, 'ja')).toBe('セクションへ移動');
  });

  it('renders a bare (unqualified) key for backward compatibility', () => {
    expect(t('cli_readiness', undefined, 'ja')).toBe('実行準備度');
    expect(t('mission_planned', undefined, 'en')).toBe('planned');
  });

  it('defaults locale to resolveLocale() (I18N-01) when omitted', () => {
    // The environment's resolved locale varies by test machine (identity
    // file / env), so this pins the *delegation*, not a fixed locale value.
    expect(t('cli_readiness')).toBe(t('cli_readiness', undefined, resolveLocale()));
  });

  it('renders simple {name} interpolation through the params argument', () => {
    expect(t('question_provide', { input: 'a project id' }, 'en')).toBe(
      'Please provide a project id.'
    );
    expect(t('question_provide', { input: 'プロジェクト ID' }, 'ja')).toBe(
      'プロジェクト ID を指定してください。'
    );
  });

  it('renders the {count}/{message}/{command} placeholders already in the catalog', () => {
    expect(t('cli_more_questions', { count: 3 }, 'en')).toBe(
      'There are 3 more clarification items.'
    );
    expect(t('cli_error_unknown_command', { command: 'frobnicate' }, 'en')).toBe(
      'Unknown command "frobnicate". Try `npm run cli -- help`.'
    );
  });

  it('warns and renders the key itself for an unknown key (type system bypassed intentionally)', () => {
    const warnSpy = vi.spyOn(core.logger, 'warn');
    const unknownKey = 'this_key_does_not_exist_anywhere' as VocabularyKey;
    expect(t(unknownKey)).toBe('this_key_does_not_exist_anywhere');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown vocabulary key'));
  });
});
