import * as React from 'react';
import './globals.css';

export const metadata = {
  title: '秘書室 — Kyberion Concierge',
  description: 'CEO秘書 — 依頼・承認・成果・例外',
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
        <header className="concierge-header">
          <div className="concierge-header-title">
            <span className="concierge-crest">秘</span>
            <div>
              <strong>秘書室</strong>
              <div className="concierge-tagline">CEO秘書 — 依頼・承認・成果・例外</div>
            </div>
          </div>
          <div className="concierge-header-note">Kyberion Concierge · port 3050</div>
        </header>
        <main className="concierge-main">{children}</main>
      </body>
    </html>
  );
}
