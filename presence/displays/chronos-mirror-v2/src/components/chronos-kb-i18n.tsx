'use client';

import { useMemo, type ReactNode } from 'react';
import { KbI18nProvider } from '@agent/shared-ui';
import { buildUiMessageBundle } from '@agent/core/locale-normalize';
import vocabularyCatalog from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';
import { useChronosLocale } from '../lib/hooks';

/**
 * UI-07: the shared-ui `ui:*` message bundle for the chronos locale, so
 * renderer defaults (status labels, empty states, chart summaries) follow the
 * operator's language toggle.
 */
export function ChronosKbI18n({ children }: { children?: ReactNode }) {
  const locale = useChronosLocale();
  const bundle = useMemo(() => buildUiMessageBundle(vocabularyCatalog, locale), [locale]);
  return (
    <KbI18nProvider locale={bundle.locale} messages={bundle.messages}>
      {children}
    </KbI18nProvider>
  );
}
