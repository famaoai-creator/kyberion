/**
 * I18N-02: a minimal ICU MessageFormat *subset* renderer.
 *
 * Deliberately not a full ICU implementation and not an external i18n
 * library dependency (see INTERNATIONALIZATION_PLAN_2026-07-26.ja.md §I18N-02
 * task 2) — the catalog only ever needs two constructs:
 *
 *  - simple interpolation: `{name}`
 *  - plural: `{count, plural, one {...} other {...}}` (only the `one` and
 *    `other` categories; no gender, ordinals, select, or date/number
 *    skeletons — those go through `libs/core/format.ts` and are passed in as
 *    an already-formatted `{...}` argument).
 *
 * Keep this file free of third-party deps and of secure-io; it is a pure
 * string transform so it can be unit-tested in isolation and reused by both
 * `t()` (Node) and any future browser-side renderer without pulling in
 * catalog-loading machinery.
 */

export type MessageParams = Record<string, string | number>;

// Matches `{name, plural, one {...} other {...}}`. The category bodies are
// captured with a non-greedy match that stops at the next `}` — this is
// correct for the supported subset because bodies never contain literal
// `{`/`}` themselves (only the `#` placeholder, substituted afterward).
const PLURAL_RE = /\{\s*(\w+)\s*,\s*plural\s*,\s*((?:\w+\s*\{[^{}]*\}\s*)+)\}/g;
const PLURAL_CATEGORY_RE = /(\w+)\s*\{([^{}]*)\}/g;
const SIMPLE_RE = /\{(\w+)\}/g;

function resolvePluralCategories(body: string): Record<string, string> {
  const categories: Record<string, string> = {};
  for (const match of body.matchAll(PLURAL_CATEGORY_RE)) {
    categories[match[1]] = match[2];
  }
  return categories;
}

function renderPluralBlock(
  argName: string,
  categoriesSource: string,
  params: MessageParams
): string {
  const categories = resolvePluralCategories(categoriesSource);
  const rawCount = params[argName];
  const count = typeof rawCount === 'number' ? rawCount : Number(rawCount);
  const category = Number.isFinite(count) && count === 1 ? 'one' : 'other';
  const chosen = categories[category] ?? categories.other ?? categories.one ?? '';
  return chosen.replace(/#/g, Number.isFinite(count) ? String(count) : '#');
}

/**
 * Renders a catalog message template against `params`.
 *
 * - Plural blocks are resolved first (they may themselves contain `{name}`
 *   placeholders and the `#` count shorthand).
 * - Remaining `{name}` tokens are substituted from `params`; a token with no
 *   matching param is left untouched (loud and greppable, matching the
 *   catalog's existing "missing key renders as the key itself" convention
 *   rather than silently swallowing a caller bug).
 */
export function renderMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  let rendered = template.replace(PLURAL_RE, (_match, argName: string, categoriesSource: string) =>
    renderPluralBlock(argName, categoriesSource, params)
  );
  rendered = rendered.replace(SIMPLE_RE, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
  return rendered;
}

/**
 * Extracts the set of `{name}` placeholder names a template references,
 * including plural argument names. Used by `check:catalogs` to verify
 * placeholders match across locales for the same key.
 */
export function extractPlaceholderNames(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLURAL_RE)) {
    names.add(match[1]);
    for (const inner of match[2].matchAll(SIMPLE_RE)) {
      names.add(inner[1]);
    }
  }
  const withoutPlurals = template.replace(PLURAL_RE, '');
  for (const match of withoutPlurals.matchAll(SIMPLE_RE)) {
    names.add(match[1]);
  }
  return [...names].sort();
}
