/**
 * Locale-keyed intent phrase lexicon — one typed matcher for the heuristic
 * intent decisions that used to be hardcoded as `/会議|meeting|…/i.test(text)`
 * literals across libs/core.
 *
 * Data: knowledge/product/governance/intent-phrase-lexicon.json
 * Schema: knowledge/product/schemas/intent-phrase-lexicon.schema.json
 *
 * Every concept lists literal phrases (escaped before compiling) and/or regex
 * source patterns per locale. By default every configured locale is checked,
 * because the language of the user's input can differ from the UI locale.
 * Adding a locale (or a phrase) is a JSON edit only — no code change.
 *
 * Each (concept, locale filter) pair is compiled once and cached against the
 * loaded lexicon object; the governed catalog reloads the file when it changes.
 */
import { pathResolver } from '../path-resolver.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';

export type IntentPhraseMatchMode = 'contains' | 'exact' | 'prefix_word';

export interface IntentPhraseLocaleEntry {
  /** Literal phrases; regex metacharacters are escaped. */
  phrases?: string[];
  /** Regex source strings for cases a literal cannot express. */
  patterns?: string[];
}

export interface IntentPhraseConcept {
  description: string;
  match?: IntentPhraseMatchMode;
  /**
   * `ascii`: literal phrases that begin/end with an ASCII word character are
   * matched as whole words (no ASCII word char immediately before/after), so
   * `me` does not match inside `meeting`. Phrases in other scripts (ja) are
   * unaffected. `prefix_word` concepts apply the trailing guard automatically.
   */
  word_boundary?: 'ascii';
  flags?: string;
  locales: Record<string, IntentPhraseLocaleEntry>;
}

export interface IntentPhraseLexicon {
  version: string;
  description?: string;
  default_flags?: string;
  concepts: Record<string, IntentPhraseConcept>;
}

export interface IntentPhraseMatchOptions {
  /**
   * Restrict matching to these locales (BCP-47 tags such as `ja-JP` or `en`).
   * A tag matches entries keyed by the full tag or its language subtag; the
   * language-neutral `und` entry is always included. Omit to check all locales.
   */
  locales?: readonly string[];
}

export interface IntentPhraseMatcher {
  readonly conceptIds: readonly string[];
  /** Locale keys configured for a concept, in declaration order. */
  localesOf(conceptId: string): string[];
  /** Unanchored alternation source `(?:…)` — compose it into a larger pattern. */
  source(conceptId: string, options?: IntentPhraseMatchOptions): string;
  /** Flags the concept compiles with (never stateful `g`/`y`). */
  flags(conceptId: string): string;
  regExp(conceptId: string, options?: IntentPhraseMatchOptions): RegExp;
  matches(text: string, conceptId: string, options?: IntentPhraseMatchOptions): boolean;
  /** First (leftmost) matched text, or undefined. */
  find(text: string, conceptId: string, options?: IntentPhraseMatchOptions): string | undefined;
}

export const INTENT_PHRASE_LEXICON_PATH = (): string =>
  pathResolver.knowledge('product/governance/intent-phrase-lexicon.json');
const INTENT_PHRASE_LEXICON_SCHEMA_PATH = (): string =>
  pathResolver.knowledge('product/schemas/intent-phrase-lexicon.schema.json');

const NEUTRAL_LOCALE = 'und';
const NEVER_MATCH = '(?!)';
/**
 * ReDoS guard: a group that contains an unbounded quantifier and is itself
 * quantified (`(a+)+`, `(?:.*x)*`, `(a|b*){2,}`) can backtrack catastrophically.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,\d*\})/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wrapForMode(body: string, mode: IntentPhraseMatchMode): string {
  if (mode === 'exact') return `^${body}$`;
  if (mode === 'prefix_word') return `^${body}`;
  return body;
}

const ASCII_WORD = /[A-Za-z0-9_]/;

/** Escape a literal phrase and guard its ASCII-word edges (never non-ASCII edges). */
function phraseAlternative(phrase: string, leading: boolean, trailing: boolean): string {
  const escaped = escapeRegExp(phrase);
  const head = leading && ASCII_WORD.test(phrase[0]) ? '(?<![A-Za-z0-9_])' : '';
  const tail = trailing && ASCII_WORD.test(phrase[phrase.length - 1]) ? '(?![A-Za-z0-9_])' : '';
  return `${head}${escaped}${tail}`;
}

function localeKeyFor(options?: IntentPhraseMatchOptions): string {
  return options?.locales?.length ? [...options.locales].sort().join(',') : '*';
}

function selectLocales(
  available: string[],
  options: IntentPhraseMatchOptions | undefined
): string[] {
  if (!options?.locales?.length) return available;
  const wanted = new Set<string>([NEUTRAL_LOCALE]);
  for (const tag of options.locales) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    wanted.add(trimmed);
    wanted.add(trimmed.split('-')[0].toLowerCase());
  }
  return available.filter((locale) => wanted.has(locale) || wanted.has(locale.split('-')[0]));
}

/** Validate one concept's patterns: they must compile and stay linear. */
function assertSafePatterns(conceptId: string, concept: IntentPhraseConcept, flags: string): void {
  for (const [locale, entry] of Object.entries(concept.locales)) {
    for (const pattern of entry.patterns || []) {
      if (NESTED_QUANTIFIER.test(pattern)) {
        throw new Error(
          `Intent phrase concept "${conceptId}" (${locale}) has a nested quantifier — rewrite "${pattern}" without (x+)+ style repetition`
        );
      }
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        throw new Error(
          `Intent phrase concept "${conceptId}" (${locale}) has an invalid pattern "${pattern}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}

export function compileIntentPhraseLexicon(lexicon: IntentPhraseLexicon): IntentPhraseMatcher {
  const defaultFlags = lexicon.default_flags ?? 'i';
  const sourceCache = new Map<string, string>();
  const regExpCache = new Map<string, RegExp>();
  const validated = new Set<string>();

  const conceptOf = (conceptId: string): IntentPhraseConcept => {
    const concept = lexicon.concepts[conceptId];
    if (!concept) {
      throw new Error(
        `Unknown intent phrase concept "${conceptId}" — add it to knowledge/product/governance/intent-phrase-lexicon.json`
      );
    }
    return concept;
  };
  const flagsOf = (conceptId: string): string => conceptOf(conceptId).flags ?? defaultFlags;

  const source = (conceptId: string, options?: IntentPhraseMatchOptions): string => {
    const cacheKey = `${conceptId}\u0000${localeKeyFor(options)}`;
    const cached = sourceCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const concept = conceptOf(conceptId);
    if (!validated.has(conceptId)) {
      assertSafePatterns(conceptId, concept, flagsOf(conceptId));
      validated.add(conceptId);
    }
    const alternatives: string[] = [];
    const wholeWord = concept.word_boundary === 'ascii';
    const prefixWord = concept.match === 'prefix_word';
    for (const locale of selectLocales(Object.keys(concept.locales), options)) {
      const entry = concept.locales[locale];
      for (const phrase of entry.phrases || []) {
        alternatives.push(phraseAlternative(phrase, wholeWord, wholeWord || prefixWord));
      }
      for (const pattern of entry.patterns || []) {
        alternatives.push(prefixWord ? `(?:${pattern})\\b` : `(?:${pattern})`);
      }
    }
    const body = alternatives.length ? `(?:${alternatives.join('|')})` : NEVER_MATCH;
    sourceCache.set(cacheKey, body);
    return body;
  };

  const regExp = (conceptId: string, options?: IntentPhraseMatchOptions): RegExp => {
    const cacheKey = `${conceptId}\u0000${localeKeyFor(options)}`;
    const cached = regExpCache.get(cacheKey);
    if (cached) return cached;
    const mode = conceptOf(conceptId).match ?? 'contains';
    const compiled = new RegExp(wrapForMode(source(conceptId, options), mode), flagsOf(conceptId));
    regExpCache.set(cacheKey, compiled);
    return compiled;
  };

  return {
    conceptIds: Object.keys(lexicon.concepts),
    localesOf: (conceptId) => Object.keys(conceptOf(conceptId).locales),
    source,
    flags: flagsOf,
    regExp,
    matches: (text, conceptId, options) => regExp(conceptId, options).test(text),
    find: (text, conceptId, options) => regExp(conceptId, options).exec(text)?.[0],
  };
}

const lexiconCatalogs = new Map<string, GovernedCatalog<IntentPhraseLexicon>>();

function catalogFor(filePath: string): GovernedCatalog<IntentPhraseLexicon> {
  const cached = lexiconCatalogs.get(filePath);
  if (cached) return cached;
  const catalog = defineCatalog<IntentPhraseLexicon>({
    id: 'intent-phrase-lexicon',
    path: filePath,
    schema: INTENT_PHRASE_LEXICON_SCHEMA_PATH(),
  });
  lexiconCatalogs.set(filePath, catalog);
  return catalog;
}

/** Load (schema-validated, cached until the file changes) the phrase lexicon. */
export function loadIntentPhraseLexicon(filePath?: string): IntentPhraseLexicon {
  // defineCatalog.load() re-asserts the repository path and reloads on change.
  return catalogFor(filePath ?? INTENT_PHRASE_LEXICON_PATH()).load();
}

const matcherCache = new WeakMap<IntentPhraseLexicon, IntentPhraseMatcher>();

/** Matcher for the governed lexicon (or a lexicon file path, e.g. a tenant overlay). */
export function getIntentPhraseMatcher(filePath?: string): IntentPhraseMatcher {
  const lexicon = loadIntentPhraseLexicon(filePath);
  let matcher = matcherCache.get(lexicon);
  if (!matcher) {
    matcher = compileIntentPhraseLexicon(lexicon);
    matcherCache.set(lexicon, matcher);
  }
  return matcher;
}

/** True when `text` contains (or, per the concept's match mode, is) a phrase of `conceptId`. */
export function matchesIntentPhrase(
  text: string,
  conceptId: string,
  options?: IntentPhraseMatchOptions
): boolean {
  return getIntentPhraseMatcher().matches(text, conceptId, options);
}

/** Leftmost matched phrase text for `conceptId`, or undefined. */
export function findIntentPhrase(
  text: string,
  conceptId: string,
  options?: IntentPhraseMatchOptions
): string | undefined {
  return getIntentPhraseMatcher().find(text, conceptId, options);
}

/** Unanchored alternation source for composing a concept into a larger pattern. */
export function intentPhraseSource(conceptId: string, options?: IntentPhraseMatchOptions): string {
  return getIntentPhraseMatcher().source(conceptId, options);
}

/** Flags a concept compiles with — pair with {@link intentPhraseSource}. */
export function intentPhraseFlags(conceptId: string): string {
  return getIntentPhraseMatcher().flags(conceptId);
}

/** Drop cached catalogs (tests / hot reload). */
export function resetIntentPhraseLexiconCache(): void {
  for (const catalog of lexiconCatalogs.values()) catalog.reset();
  lexiconCatalogs.clear();
}
