"use client";

import { useEffect, useState } from "react";
import { resolveChronosLocale, SupportedLocale } from "./ux-vocabulary";

/**
 * React hook to safely resolve locale on the client while maintaining
 * hydration consistency with the server default.
 */
export function useChronosLocale(): SupportedLocale {
  // Use a stable default during SSR
  const [locale, setLocale] = useState<SupportedLocale>("en");

  useEffect(() => {
    setLocale(resolveChronosLocale());
  }, []);

  return locale;
}
