import * as React from 'react';
import './globals.css';
import { ConciergeHeader } from './concierge-header';

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
      </body>
    </html>
  );
}
