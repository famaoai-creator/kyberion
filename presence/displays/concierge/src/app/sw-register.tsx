'use client';

import * as React from 'react';

/** Registers the installability service worker. Best-effort: never blocks the UI. */
export function ServiceWorkerRegister(): null {
  React.useEffect(() => {
    try {
      if (typeof window === 'undefined' || !window.isSecureContext) return;
      if (!('serviceWorker' in navigator)) return;
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    } catch {
      // Unsupported or blocked (private mode): the surface works without it.
    }
  }, []);
  return null;
}
