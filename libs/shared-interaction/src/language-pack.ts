/**
 * Language packs for the Interaction Controller (CE-07 language extensibility).
 *
 * A LanguagePack is a pure-data description of one language's turn-taking
 * cues — continuation markers, fillers, commit endings, user backchannels,
 * correction/hold markers, and the phrases the agent itself may emit as
 * backchannels. Packs come from the governed lexicon
 * (knowledge/product/voice/turn-taking-lexicon.json); adding a language is a
 * data change, not a code change. The engine only ever touches language
 * through this interface, so it is neither English- nor Japanese-specific.
 *
 * Pure — no timers, no I/O. The loader takes a plain parsed-lexicon object so
 * tests never touch the filesystem.
 */

export interface LanguagePack {
  /** Language id, e.g. 'ja', 'en'. */
  id: string;
  /** True when words are separated by spaces (affects word counting/normalization). */
  usesWordSpaces: boolean;
  /** Charset/script hint used by `detectLanguagePack`. */
  detectPattern?: RegExp;
  /** Utterance-final markers that mean "not done yet" (continuation particles, trailing conjunctions). */
  continuationMarkers: readonly string[];
  /** Fillers that hold the floor without closing a turn. */
  eotFillers: readonly string[];
  /** Utterance-final markers that commit a turn. */
  commitEndings: readonly string[];
  /** Pure-filler lists for the respond gate. */
  respondGateFillers: readonly string[];
  /** User backchannels — they must not confirm a barge-in nor demand a full reply. */
  userBackchannels: readonly string[];
  /** Markers meaning the user is correcting the assistant. */
  correctionMarkers: readonly string[];
  /** Markers meaning the user asks the assistant to wait/hold. */
  holdMarkers: readonly string[];
  /** Phrases the agent itself may emit as backchannels or instant reactions. */
  agentBackchannels: readonly string[];
  /** Suffixes that mark a question in this language (beyond '?'). */
  questionEndings: readonly string[];
  /** Openers marking a "next step / wrap-up" reply segment (CE-06). */
  nextStepMarkers: readonly string[];
}

/** Minimal shape a lexicon language entry must satisfy to become a pack. */
export interface LanguagePackSource {
  /** Required, explicit per language — never inferred from a language id. */
  uses_word_spaces: boolean;
  continuation_particles?: readonly string[];
  eot_fillers?: readonly string[];
  commit_endings?: readonly string[];
  respond_gate_fillers?: readonly string[];
  barge_in_backchannels?: readonly string[];
  correction_markers?: readonly string[];
  hold_markers?: readonly string[];
  agent_backchannels?: readonly string[];
  /** Suffixes that mark a question in this language (beyond '?'). */
  question_endings?: readonly string[];
  /** Openers marking a "next step / wrap-up" reply segment (CE-06). */
  next_step_markers?: readonly string[];
}

/** Charset hints keyed by language id — script detection, not linguistic data. */
const SCRIPT_HINTS: Record<string, RegExp> = {
  ja: /[぀-ゟ゠-ヿ一-鿿]/u,
};

function readonlyList(value: readonly string[] | undefined): readonly string[] {
  return value ? Object.freeze([...value]) : Object.freeze([]);
}

/** Build a LanguagePack from one parsed lexicon entry. */
export function languagePackFromSource(id: string, source: LanguagePackSource): LanguagePack {
  return {
    id,
    usesWordSpaces: source.uses_word_spaces,
    ...(SCRIPT_HINTS[id] ? { detectPattern: SCRIPT_HINTS[id] } : {}),
    continuationMarkers: readonlyList(source.continuation_particles),
    eotFillers: readonlyList(source.eot_fillers),
    commitEndings: readonlyList(source.commit_endings),
    respondGateFillers: readonlyList(source.respond_gate_fillers),
    userBackchannels: readonlyList(source.barge_in_backchannels),
    correctionMarkers: readonlyList(source.correction_markers),
    holdMarkers: readonlyList(source.hold_markers),
    agentBackchannels: readonlyList(source.agent_backchannels),
    questionEndings: readonlyList(source.question_endings),
    nextStepMarkers: readonlyList(source.next_step_markers),
  };
}

/**
 * Build packs from a parsed lexicon map (`{ ja: {...}, en: {...} }`).
 * `uses_word_spaces` is required on every entry — never inferred from the
 * language id.
 */
export function languagePacksFromLexicon(
  languages: Record<string, LanguagePackSource>
): LanguagePack[] {
  return Object.entries(languages).map(([id, source]) => languagePackFromSource(id, source));
}

/**
 * Pick the pack whose `detectPattern` matches `text`. Falls back to the pack
 * whose id equals `fallbackId`, else the first pack. Language packs without a
 * detect pattern can still be selected by fallback (e.g. 'en' is the default
 * when no script hint matches).
 */
export function detectLanguagePack(
  text: string,
  packs: readonly LanguagePack[],
  fallbackId = 'en'
): LanguagePack | null {
  if (packs.length === 0) return null;
  for (const pack of packs) {
    if (pack.detectPattern?.test(text)) return pack;
  }
  return packs.find((pack) => pack.id === fallbackId) ?? packs[0];
}

/** Resolve a pack by id, or detect from text when `id` is 'auto'/undefined. */
export function resolveLanguagePack(
  text: string,
  packs: readonly LanguagePack[],
  id?: string
): LanguagePack | null {
  if (packs.length === 0) return null;
  if (id && id !== 'auto') return packs.find((pack) => pack.id === id) ?? null;
  return detectLanguagePack(text, packs);
}
