'use client';

import * as React from 'react';
import Link from 'next/link';
import { A2UIActionProvider, AppShell, KbI18nProvider, type A2UILinkProps } from '@agent/shared-ui';
import { buildUiMessageBundle } from '@agent/core/locale-normalize';
import vocabularyCatalog from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';
import { ConciergeI18nProvider, useConciergeI18n } from '../lib/use-concierge-i18n';
import {
  onDisplayPreferencesChange,
  readDisplayPreferences,
  type ConciergeDensityPreference,
} from '../lib/concierge-theme';

/**
 * UI-05/UI-06 — the concierge shell: `ui:app-shell` (comfortable density,
 * concierge role) with the shared front-desk rail in the nav slot and one
 * centred content column. Owns the providers every page shares:
 *   - the surface locale (`ConciergeI18nProvider`),
 *   - the shared-ui renderer locale + `ui:*` message bundle
 *     (`KbI18nProvider`, built from the same vocabulary catalog),
 *   - `next/link` for kb links (`A2UIActionProvider.linkComponent`), so
 *     in-app rail / tab links route client-side.
 * `overlays` (conversation dock, ⌘K palette) render outside the grid but
 * inside the providers. Density defaults to comfortable (front-desk
 * surface) and follows the viewer's 設定 › 表示 choice.
 */

function NextKbLink({ href, children, ...rest }: A2UILinkProps) {
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}

function ConciergeUiProviders({ children }: { children?: React.ReactNode }) {
  const { locale } = useConciergeI18n();
  const bundle = React.useMemo(() => buildUiMessageBundle(vocabularyCatalog, locale), [locale]);
  return (
    <KbI18nProvider locale={bundle.locale} messages={bundle.messages}>
      <A2UIActionProvider linkComponent={NextKbLink}>{children}</A2UIActionProvider>
    </KbI18nProvider>
  );
}

function useDisplayDensity(): ConciergeDensityPreference {
  const [density, setDensity] = React.useState<ConciergeDensityPreference>('comfortable');
  React.useEffect(() => {
    setDensity(readDisplayPreferences().density);
    return onDisplayPreferencesChange((prefs) => setDensity(prefs.density));
  }, []);
  return density;
}

export function ConciergeShell({
  nav,
  overlays,
  children,
}: {
  nav: React.ReactNode;
  overlays?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const density = useDisplayDensity();
  return (
    <ConciergeI18nProvider>
      <ConciergeUiProviders>
        <AppShell density={density} role="concierge" nav={nav}>
          <div className="concierge-column">{children}</div>
        </AppShell>
        {overlays}
      </ConciergeUiProviders>
    </ConciergeI18nProvider>
  );
}
