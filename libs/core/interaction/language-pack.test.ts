import { describe, expect, it } from 'vitest';
import {
  detectLanguagePack,
  languagePackFromSource,
  languagePacksFromLexicon,
  resolveLanguagePack,
} from './language-pack.js';

const lexicon = {
  ja: {
    uses_word_spaces: false,
    question_endings: ['か'],
    continuation_particles: ['けど'],
    eot_fillers: ['えーと'],
    commit_endings: ['です'],
    respond_gate_fillers: ['えーと'],
    barge_in_backchannels: ['うん'],
    correction_markers: ['いや'],
    hold_markers: ['ちょっと待って'],
    agent_backchannels: ['うん', 'はい'],
  },
  en: {
    uses_word_spaces: true,
    continuation_particles: ['and'],
    eot_fillers: ['um'],
    commit_endings: [],
    respond_gate_fillers: ['um'],
    barge_in_backchannels: ['yeah'],
    correction_markers: ['wrong'],
    hold_markers: ['wait'],
    agent_backchannels: ['yeah'],
  },
};

describe('language packs', () => {
  it('builds a pack per language entry (data-driven)', () => {
    const packs = languagePacksFromLexicon(lexicon);
    expect(packs.map((p) => p.id)).toEqual(['ja', 'en']);
    expect(packs[0].usesWordSpaces).toBe(false);
    expect(packs[1].usesWordSpaces).toBe(true);
    expect(packs[0].agentBackchannels).toEqual(['うん', 'はい']);
  });

  it('detects Japanese text via script hints and falls back to en', () => {
    const packs = languagePacksFromLexicon(lexicon);
    expect(detectLanguagePack('こんにちは', packs)?.id).toBe('ja');
    expect(detectLanguagePack('hello there', packs)?.id).toBe('en');
    expect(detectLanguagePack('', packs)?.id).toBe('en');
  });

  it('resolves an explicit pack id, or auto-detects', () => {
    const packs = languagePacksFromLexicon(lexicon);
    expect(resolveLanguagePack('hello', packs, 'ja')?.id).toBe('ja');
    expect(resolveLanguagePack('ありがとう', packs, 'auto')?.id).toBe('ja');
    expect(resolveLanguagePack('x', [], 'ja')).toBeNull();
  });

  it('a new language is a data-only addition', () => {
    const packs = languagePacksFromLexicon({
      ...lexicon,
      ko: { uses_word_spaces: true, agent_backchannels: ['네'], barge_in_backchannels: ['네'] },
    });
    const ko = packs.find((p) => p.id === 'ko');
    expect(ko?.agentBackchannels).toEqual(['네']);
    expect(ko?.usesWordSpaces).toBe(true);
  });
});
