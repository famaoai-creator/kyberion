import * as React from 'react';
// Shared UI layer (UI-02): --kb-ui-* tokens + the .kb-* component contract.
// globals.css only keeps concierge-specific pieces, styled with the same tokens.
import './kyberion-ui-tokens.css';
import './kyberion-ui.css';
import './globals.css';
import { readFrontDeskSurfacePorts } from '@agent/core/front-desk-nav';
import { THEME_BOOTSTRAP_SCRIPT } from '../lib/concierge-theme';
import { ConciergeShell } from './concierge-shell';
import { ConciergeHeader } from './concierge-header';
import { ConversationDock } from './conversation-dock';
import { CommandPalette } from './command-palette';
import { FrontDeskRail } from './front-desk-rail';

// Surface identity contract: surface:concierge_surface_tagline

export const metadata = {
  title: 'Concierge — Kyberion',
  description: 'Executive secretary surface for requests, approvals, outcomes, and exceptions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // FD-00c follow-up: `RootLayout` has no `'use client'` directive, so it is
  // a Server Component — it may read the surface manifest directly and pass
  // the resolved (never hardcoded) ports down as a plain serializable prop.
  // `CommandPalette` needs them to build its 3 cross-surface hrefs without
  // importing `@agent/core/front-desk-nav` itself (that module pulls in
  // `surface-runtime`/`secure-io`, which cannot be bundled for the browser).
  const frontDeskPorts = readFrontDeskSurfacePorts();

  return (
    // `data-theme` (a pinned light/dark choice) and `lang` are set on the
    // client before paint / after hydration, hence suppressHydrationWarning.
    <html lang="ja" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        {/* UI-05/06: `ui:app-shell` with the shared front-desk rail
            (`ui:nav-rail`) and the surface header (`ui:page-header`). The
            secretary conversation (CS-01) and the ⌘K palette (CS-04) are
            available on every page, so they mount here as overlays. */}
        <ConciergeShell
          nav={<FrontDeskRail />}
          overlays={
            <>
              <ConversationDock />
              <CommandPalette frontDeskPorts={frontDeskPorts} />
            </>
          }
        >
          <ConciergeHeader />
          {children}
        </ConciergeShell>
      </body>
    </html>
  );
}
