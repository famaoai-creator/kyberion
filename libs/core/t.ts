import { logger } from './core.js';
import { resolveLocale as resolveUnifiedLocale, type SupportedLocale } from './locale.js';
import { renderMessage, type MessageParams } from './message-format.js';
import { loadVocabularyCatalog, resolveVocabularyEntry } from './vocabulary-catalog.js';
import type { VocabularyKey } from './vocabulary-keys.generated.js';

export type { VocabularyKey };

/**
 * I18N-02: the single type-safe rendering entry point for the namespaced
 * user-facing vocabulary catalog.
 *
 * `key` is a generated union (`libs/core/vocabulary-keys.generated.ts`), so
 * referencing a key that does not exist in the catalog is a compile-time
 * error, not a runtime "renders the key itself" surprise. The generated
 * union includes both the canonical `namespace:key` qualified form and (for
 * the one-release backward-compat window called for by I18N-02) the bare
 * `key` form for every key that is unambiguous across namespaces.
 *
 * `params` renders through the ICU MessageFormat subset in
 * `message-format.ts` (simple `{name}` interpolation and
 * `{count, plural, one {...} other {...}}`).
 *
 * `locale` defaults to `resolveLocale()` (I18N-01).
 */
export function t(key: VocabularyKey, params?: MessageParams, locale?: SupportedLocale): string {
  const resolvedLocale = locale ?? resolveUnifiedLocale();
  const catalog = loadVocabularyCatalog();
  const resolved = resolveVocabularyEntry(key);
  if (!resolved) {
    logger.warn(`[t] Unknown vocabulary key "${key}"; rendering the key itself.`);
    return key;
  }
  const defaultLocale = catalog?.default_locale || 'en';
  const template =
    resolved.entry[resolvedLocale] ??
    resolved.entry[defaultLocale] ??
    Object.values(resolved.entry)[0];
  if (template === undefined) {
    logger.warn(`[t] Vocabulary key "${key}" has no localized text; rendering the key itself.`);
    return key;
  }
  return renderMessage(template, params);
}
