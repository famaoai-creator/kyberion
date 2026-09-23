/**
 * Deterministic end-of-turn (EOT) scoring for streaming voice input (EV-03),
 * with Japanese-language support (kyberion is Japanese-first; the elizaOS
 * design reference — `packages/shared/src/voice-eot.ts` — is English-only).
 *
 * `scoreEndOfTurn(text)` returns P(the speaker is DONE) in [0, 1]: high →
 * commit the turn, low → the utterance trails off and should be held for
 * more speech. `EotHoldAggregator` wraps the scorer with a hold/commit
 * state machine so a partial-transcript feed only emits committed text.
 *
 * Pure + injectable clock/timer — no globals, no real timers in tests.
 */

export type VoiceEotLang = 'ja' | 'en' | 'auto';

export interface EotScore {
  /** P(turn complete) in [0, 1]. High → commit, low → hold. */
  probability: number;
  /** Language the rule table matched against. */
  lang: 'ja' | 'en';
  /** Which rule fired, for telemetry/tests. */
  rule:
    | 'empty'
    | 'sentence_final_punctuation'
    | 'commit_ending'
    | 'continuation_particle'
    | 'filler'
    | 'trailing_conjunction'
    | 'no_signal';
}

// ---------------------------------------------------------------------------
// Japanese rule table
// ---------------------------------------------------------------------------

/** Continuation particles at the end of an utterance imply the speaker is mid-clause. */
const JA_CONTINUATION_PARTICLES = [
  'けれど',
  'けど',
  'ので',
  'のに',
  'たら',
  'って',
  'て',
  'で',
  'が',
  'し',
  'から',
  'と',
  '、',
];

/** Spoken fillers/hedges — the speaker is holding the floor, not done. */
const JA_FILLERS = ['えーと', 'えっと', 'あの', 'その', 'まあ', 'うーん', 'ええと'];

/** Sentence-final markers / polite endings that read as complete. */
const JA_COMMIT_ENDINGS = ['です', 'ます', 'ください', 'か'];

const JA_SENTENCE_FINAL_PUNCTUATION = /[。！？!?]$/;

// ---------------------------------------------------------------------------
// English rule table
// ---------------------------------------------------------------------------

const EN_TRAILING_CONJUNCTIONS = new Set([
  'and',
  'but',
  'so',
  'because',
  'or',
  'the',
  'a',
  'to',
  'with',
]);
const EN_SENTENCE_FINAL_PUNCTUATION = /[.!?]$/;

function hasHiragana(text: string): boolean {
  return /[぀-ゟ]/u.test(text);
}

function hasKatakana(text: string): boolean {
  return /[゠-ヿ]/u.test(text);
}

function hasKanji(text: string): boolean {
  return /[一-鿿]/u.test(text);
}

/** Auto-detect: any hiragana/katakana/kanji present → Japanese, else English. */
function detectLang(text: string): 'ja' | 'en' {
  return hasHiragana(text) || hasKatakana(text) || hasKanji(text) ? 'ja' : 'en';
}

function scoreJapanese(text: string): EotScore {
  if (JA_SENTENCE_FINAL_PUNCTUATION.test(text)) {
    return { probability: 0.95, lang: 'ja', rule: 'sentence_final_punctuation' };
  }
  for (const ending of JA_COMMIT_ENDINGS) {
    if (text.endsWith(ending)) {
      return { probability: 0.9, lang: 'ja', rule: 'commit_ending' };
    }
  }
  for (const filler of JA_FILLERS) {
    if (text.endsWith(filler)) {
      return { probability: 0.15, lang: 'ja', rule: 'filler' };
    }
  }
  for (const particle of JA_CONTINUATION_PARTICLES) {
    if (text.endsWith(particle)) {
      return { probability: 0.2, lang: 'ja', rule: 'continuation_particle' };
    }
  }
  return { probability: 0.5, lang: 'ja', rule: 'no_signal' };
}

function scoreEnglish(text: string): EotScore {
  if (EN_SENTENCE_FINAL_PUNCTUATION.test(text)) {
    return { probability: 0.95, lang: 'en', rule: 'sentence_final_punctuation' };
  }
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/gi, '')
    .split(/\s+/)
    .filter(Boolean);
  const lastWord = words[words.length - 1];
  if (lastWord && EN_TRAILING_CONJUNCTIONS.has(lastWord)) {
    return { probability: 0.15, lang: 'en', rule: 'trailing_conjunction' };
  }
  return { probability: 0.5, lang: 'en', rule: 'no_signal' };
}

/**
 * Probability in [0,1] that `text` is a COMPLETE turn. `lang` picks the rule
 * table; `'auto'` (the default) detects Japanese by script presence, English
 * otherwise. Rules fire in priority order (sentence-final punctuation and
 * polite/question endings commit; continuation particles and fillers hold).
 */
export function scoreEndOfTurn(text: string, lang: VoiceEotLang = 'auto'): EotScore {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { probability: 0.5, lang: lang === 'ja' ? 'ja' : 'en', rule: 'empty' };
  }
  const resolvedLang = lang === 'auto' ? detectLang(trimmed) : lang;
  return resolvedLang === 'ja' ? scoreJapanese(trimmed) : scoreEnglish(trimmed);
}

// ---------------------------------------------------------------------------
// Hold aggregator
// ---------------------------------------------------------------------------

export interface EotHoldAggregatorOptions {
  /** Commit immediately when the accumulated text scores at or above this. Default 0.5. */
  commitThreshold?: number;
  /** Maximum time to hold an unfinished-looking turn before committing anyway. Default 1500ms. */
  maxHoldMs?: number;
  /** Wall-clock source (injectable for tests). Default Date.now. */
  now?: () => number;
  /** Language passed through to `scoreEndOfTurn`. Default 'auto'. */
  lang?: VoiceEotLang;
}

export interface EotHoldResult {
  commit: boolean;
  text: string;
}

/**
 * Accumulates partial-transcript finals into one logical turn. A final that
 * scores as complete commits at once; one that trails off is held and the
 * next final is appended to it (Japanese: no separator; English: single
 * space), until `maxHoldMs` elapses and `tick()` forces a commit.
 */
export class EotHoldAggregator {
  private readonly commitThreshold: number;
  private readonly maxHoldMs: number;
  private readonly now: () => number;
  private readonly lang: VoiceEotLang;
  private buffer = '';
  private heldSinceMs: number | null = null;

  constructor(options: EotHoldAggregatorOptions = {}) {
    this.commitThreshold = options.commitThreshold ?? 0.5;
    this.maxHoldMs = options.maxHoldMs ?? 1500;
    this.now = options.now ?? (() => Date.now());
    this.lang = options.lang ?? 'auto';
  }

  /** The text currently held while waiting to see if the speaker continues. */
  get pending(): string {
    return this.buffer;
  }

  /** Feed a finalized transcript fragment. Returns whether it committed and what text. */
  offer(finalText: string): EotHoldResult {
    const trimmed = finalText.trim();
    if (!trimmed) {
      return { commit: false, text: this.buffer };
    }
    this.buffer = this.appendFragment(this.buffer, trimmed);

    const score = scoreEndOfTurn(this.buffer, this.lang);
    if (score.probability >= this.commitThreshold) {
      return this.commitNow();
    }
    if (this.heldSinceMs === null) {
      this.heldSinceMs = this.now();
    }
    return { commit: false, text: this.buffer };
  }

  /**
   * Caller-driven check: force a commit once `maxHoldMs` has elapsed since
   * the turn started being held. Returns null while still within budget or
   * when nothing is buffered.
   */
  tick(): EotHoldResult | null {
    if (this.buffer.length === 0 || this.heldSinceMs === null) return null;
    if (this.now() - this.heldSinceMs < this.maxHoldMs) return null;
    return this.commitNow();
  }

  /** Discard any buffered turn without committing. */
  reset(): void {
    this.buffer = '';
    this.heldSinceMs = null;
  }

  private commitNow(): EotHoldResult {
    const text = this.buffer;
    this.buffer = '';
    this.heldSinceMs = null;
    return { commit: true, text };
  }

  private appendFragment(buffer: string, fragment: string): string {
    if (!buffer) return fragment;
    const resolvedLang = this.lang === 'auto' ? detectLang(buffer + fragment) : this.lang;
    return resolvedLang === 'ja' ? `${buffer}${fragment}` : `${buffer} ${fragment}`;
  }
}
