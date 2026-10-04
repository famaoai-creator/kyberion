/**
 * Language-pack lexical cues shared by the turn-taking modules (EOT scorer,
 * two-stage barge-in, respond gate, utterance intent). Kept as governed data
 * in knowledge/product/voice/turn-taking-lexicon.json so the word lists can
 * grow — and new languages can be added — without code changes and are not
 * mistaken for user-facing copy. `ja` keeps its original five required keys
 * for compatibility; every language entry may also carry the CE-04/CE-05
 * intent and agent-backchannel lists.
 */

import { readJson } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';

/** Optional per-language cue lists; missing lists default to empty. */
export interface TurnTakingLanguageEntry {
  /**
   * True when words are space-separated (en); false for unspaced scripts
   * (ja/zh/th). Required on every entry — never inferred from the id.
   */
  uses_word_spaces: boolean;
  continuation_particles?: readonly string[];
  eot_fillers?: readonly string[];
  commit_endings?: readonly string[];
  respond_gate_fillers?: readonly string[];
  barge_in_backchannels?: readonly string[];
  /** Utterance-intent cues: user is correcting the assistant. */
  correction_markers?: readonly string[];
  /** Utterance-intent cues: user asks the assistant to wait/hold. */
  hold_markers?: readonly string[];
  /** Phrases the assistant itself may emit as backchannels/reactions. */
  agent_backchannels?: readonly string[];
  /** Suffixes that mark a question in this language (beyond '?'). */
  question_endings?: readonly string[];
}

export interface VoiceTurnTakingLexicon {
  ja: {
    continuation_particles: readonly string[];
    eot_fillers: readonly string[];
    commit_endings: readonly string[];
    respond_gate_fillers: readonly string[];
    barge_in_backchannels: readonly string[];
  } & TurnTakingLanguageEntry;
  /** Every language entry keyed by language id (includes `ja`). */
  languages: Record<string, TurnTakingLanguageEntry>;
}

const LEXICON_PATH = 'knowledge/product/voice/turn-taking-lexicon.json';
const METADATA_KEYS = new Set(['version', 'description']);

let cached: VoiceTurnTakingLexicon | undefined;

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`[VOICE_LEXICON_INVALID] ${field} must be a list of non-empty strings`);
  }
  return Object.freeze([...(value as string[])]);
}

function optionalStringList(value: unknown, field: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  return stringList(value, field);
}

function languageEntry(raw: Record<string, unknown>, lang: string): TurnTakingLanguageEntry {
  if (typeof raw.uses_word_spaces !== 'boolean') {
    throw new Error(`[VOICE_LEXICON_INVALID] ${lang}.uses_word_spaces must be a boolean`);
  }
  return {
    uses_word_spaces: raw.uses_word_spaces,
    continuation_particles: optionalStringList(
      raw.continuation_particles,
      `${lang}.continuation_particles`
    ),
    eot_fillers: optionalStringList(raw.eot_fillers, `${lang}.eot_fillers`),
    commit_endings: optionalStringList(raw.commit_endings, `${lang}.commit_endings`),
    respond_gate_fillers: optionalStringList(
      raw.respond_gate_fillers,
      `${lang}.respond_gate_fillers`
    ),
    barge_in_backchannels: optionalStringList(
      raw.barge_in_backchannels,
      `${lang}.barge_in_backchannels`
    ),
    correction_markers: optionalStringList(raw.correction_markers, `${lang}.correction_markers`),
    hold_markers: optionalStringList(raw.hold_markers, `${lang}.hold_markers`),
    agent_backchannels: optionalStringList(raw.agent_backchannels, `${lang}.agent_backchannels`),
    question_endings: optionalStringList(raw.question_endings, `${lang}.question_endings`),
  };
}

export function loadVoiceTurnTakingLexicon(): VoiceTurnTakingLexicon {
  if (cached) return cached;
  const raw = readJson<Record<string, unknown>>(pathResolver.rootResolve(LEXICON_PATH));
  const languages: Record<string, TurnTakingLanguageEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (METADATA_KEYS.has(key) || typeof value !== 'object' || value === null) continue;
    languages[key] = languageEntry(value as Record<string, unknown>, key);
  }
  const ja = (raw.ja ?? {}) as Record<string, unknown>;
  cached = {
    ja: {
      continuation_particles: stringList(ja.continuation_particles, 'ja.continuation_particles'),
      eot_fillers: stringList(ja.eot_fillers, 'ja.eot_fillers'),
      commit_endings: stringList(ja.commit_endings, 'ja.commit_endings'),
      respond_gate_fillers: stringList(ja.respond_gate_fillers, 'ja.respond_gate_fillers'),
      barge_in_backchannels: stringList(ja.barge_in_backchannels, 'ja.barge_in_backchannels'),
      ...languageEntry(ja, 'ja'),
    },
    languages,
  };
  return cached;
}
