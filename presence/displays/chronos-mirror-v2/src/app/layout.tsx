import type { Metadata } from 'next';
// Shared UI layer (UI-02/UI-07): the .kb-* component contract first, then the
// Chronos token file (--kb-ui-* plus the legacy palette re-pointed at them).
import './kyberion-ui.css';
import './globals.css';
import { CHRONOS_THEME_BOOTSTRAP_SCRIPT } from '../lib/chronos-theme';

export const metadata: Metadata = {
  title: 'Chronos Mirror v2 | Kyberion',
  description: 'The Sovereign Intelligent Interface',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `data-theme` (a pinned light/dark choice) is applied before paint by the
    // bootstrap script and `lang` follows the viewer's locale after hydration,
    // hence suppressHydrationWarning. Chronos is a compact-density surface.
    <html lang="en" data-density="compact" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: CHRONOS_THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="antialiased overflow-x-hidden" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
