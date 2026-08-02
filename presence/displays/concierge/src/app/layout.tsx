import * as React from 'react';
import './globals.css';
import { ConciergeHeader } from './concierge-header';
import { ConversationDock } from './conversation-dock';
import { CommandPalette } from './command-palette';

// Surface identity contract: CEO秘書 — 依頼・承認・成果・例外

export const metadata = {
  title: 'Concierge — Kyberion',
  description: 'Executive secretary surface for requests, approvals, outcomes, and exceptions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="/api/theme" />
      </head>
      <body>
        <ConciergeHeader />
        <main className="concierge-main">{children}</main>
        {/* CS-01: the secretary conversation is available on every page
            (home and /setup), so it is mounted in the layout. */}
        <ConversationDock />
        {/* CS-04: ⌘K palette, also on every page. */}
        <CommandPalette />
      </body>
    </html>
  );
}
