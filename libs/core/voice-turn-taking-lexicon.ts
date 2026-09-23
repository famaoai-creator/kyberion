/**
 * Japanese lexical cues shared by the turn-taking modules (EOT scorer,
 * two-stage barge-in, respond gate). Kept as governed data in
 * knowledge/product/voice/turn-taking-lexicon.json so the word lists can grow
 * without code changes and are not mistaken for user-facing copy.
 */

import { readJson } from './foundation/json.js';
import { pathResolver } from './path-resolver.js';

export interface VoiceTurnTakingLexicon {
  ja: {
    continuation_particles: readonly string[];
    eot_fillers: readonly string[];
    commit_endings: readonly string[];
    respond_gate_fillers: readonly string[];
    barge_in_backchannels: readonly string[];
  };
}

const LEXICON_PATH = 'knowledge/product/voice/turn-taking-lexicon.json';

let cached: VoiceTurnTakingLexicon | undefined;

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`[VOICE_LEXICON_INVALID] ${field} must be a list of non-empty strings`);
  }
  return Object.freeze([...(value as string[])]);
}

export function loadVoiceTurnTakingLexicon(): VoiceTurnTakingLexicon {
  if (cached) return cached;
  const raw = readJson<{ ja?: Record<string, unknown> }>(pathResolver.rootResolve(LEXICON_PATH));
  const ja = raw.ja ?? {};
  cached = {
    ja: {
      continuation_particles: stringList(ja.continuation_particles, 'ja.continuation_particles'),
      eot_fillers: stringList(ja.eot_fillers, 'ja.eot_fillers'),
      commit_endings: stringList(ja.commit_endings, 'ja.commit_endings'),
      respond_gate_fillers: stringList(ja.respond_gate_fillers, 'ja.respond_gate_fillers'),
      barge_in_backchannels: stringList(ja.barge_in_backchannels, 'ja.barge_in_backchannels'),
    },
  };
  return cached;
}
