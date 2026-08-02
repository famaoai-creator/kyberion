'use client';

import * as React from 'react';
import {
  conciergeText,
  detectConciergeLocale,
  type ConciergeLocale,
  type ConciergeMessageKey,
} from './i18n';

export function useConciergeI18n() {
  const [locale, setLocale] = React.useState<ConciergeLocale>('ja');

  React.useEffect(() => {
    setLocale(detectConciergeLocale());
  }, []);

  const t = React.useCallback(
    (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params),
    [locale]
  );

  return { locale, setLocale, t };
}
