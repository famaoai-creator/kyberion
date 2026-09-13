import * as React from 'react';
import './globals.css';
import { readFrontDeskSurfacePorts } from '@agent/core/front-desk-nav';
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
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/api/theme" />
      </head>
      <body>
        {/* FD-00c: the shared front-desk rail (5 human-verb items) replaces
            the header's own nav links; the header keeps only the crest,
            tagline, and locale switcher. */}
        <div className="fd-layout">
          <FrontDeskRail />
          <div className="fd-content">
            <ConciergeHeader />
            <main className="concierge-main">{children}</main>
          </div>
        </div>
        {/* CS-01: the secretary conversation is available on every page
            (home and /setup), so it is mounted in the layout. */}
        <ConversationDock />
        {/* CS-04: ⌘K palette, also on every page. */}
        <CommandPalette frontDeskPorts={frontDeskPorts} />
      </body>
    </html>
  );
}
