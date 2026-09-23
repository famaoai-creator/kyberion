import * as React from 'react';
import { getTenantScope } from '@/lib/data';
import { operatorTranslator, operatorUiMessages } from '@/lib/i18n';
import { getRequestLocale } from '@/lib/request-locale';
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/display-preferences';
import { OperatorShell, type OperatorNavItem } from './operator-shell';
// Shared UI layer (UI-02): globals.css carries the generated --kb-* / --kb-ui-*
// tokens, kyberion-ui.css the .kb-* component contract; operator.css only
// operator-specific layout, styled with the same tokens.
import './globals.css';
import './kyberion-ui.css';
import './operator.css';

// Surface identity contract: surface:operator_surface_tagline (監査モニタ,
// read-only) — rendered as the brand subtitle and the page-header role badge.

export const metadata = {
  title: 'Kyberion Operator Surface',
  description: 'Read-only operator view: missions, audit chain, health',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const scope = getTenantScope();
  const locale = await getRequestLocale();
  const t = operatorTranslator(locale);
  const items: OperatorNavItem[] = [
    { id: 'missions', label: t('nav_missions'), href: '/', icon: 'mission' },
    { id: 'audit', label: t('nav_audit'), href: '/audit', icon: 'shield' },
    { id: 'health', label: t('nav_health'), href: '/health', icon: 'chart' },
    { id: 'reasoning', label: t('nav_reasoning'), href: '/reasoning', icon: 'chat' },
    { id: 'surfaces', label: t('nav_surfaces'), href: '/surfaces', icon: 'settings' },
    {
      id: 'intent-snapshots',
      label: t('nav_intent_snapshots'),
      href: '/intent-snapshots',
      icon: 'clock',
    },
    { id: 'knowledge', label: t('nav_knowledge'), href: '/knowledge', icon: 'book' },
  ];
  return (
    // `data-theme` (a pinned light/dark choice) is set before paint by the
    // bootstrap script, hence suppressHydrationWarning.
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <OperatorShell
          locale={locale}
          messages={operatorUiMessages(locale)}
          navLabel={t('nav_label')}
          brand={{ name: t('brand_name'), subtitle: t('brand_role') }}
          context={{
            label: scope ?? t('tenant_agnostic'),
            detail: t('tenant_context_detail'),
          }}
          items={items}
          roleBadge={t('role_badge')}
        >
          {children}
        </OperatorShell>
      </body>
    </html>
  );
}
