'use client';

import { useEffect, useState } from 'react';
import { CHRONOS_LOCALE_EVENT, resolveChronosLocale, SupportedLocale } from './ux-vocabulary';

/**
 * React hook to safely resolve locale on the client while maintaining
 * hydration consistency with the server default. Re-renders when the
 * operator changes the language via the header toggle (UX-03).
 */
export function useChronosLocale(): SupportedLocale {
  // Use a stable default during SSR
  const [locale, setLocale] = useState<SupportedLocale>('en');

  useEffect(() => {
    setLocale(resolveChronosLocale());
    const onChange = () => setLocale(resolveChronosLocale());
    window.addEventListener(CHRONOS_LOCALE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(CHRONOS_LOCALE_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  return locale;
}
