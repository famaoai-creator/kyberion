import * as React from 'react';
import { getTenantScope } from '@/lib/data';

export const metadata = {
  title: 'Kyberion Operator Surface',
  description: 'Read-only operator view: missions, audit chain, health',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const scope = getTenantScope();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body
        style={{
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          margin: 0,
          padding: 0,
          background: '#0c0d10',
          color: '#e4e6eb',
        }}
      >
        <header
          style={{
            padding: '12px 24px',
            background: '#15171c',
            borderBottom: '1px solid #2a2c33',
            display: 'flex',
            gap: '24px',
            alignItems: 'baseline',
          }}
        >
          <strong>Kyberion · Operator Surface</strong>
          <nav style={{ display: 'flex', gap: '16px', fontSize: '14px' }}>
            <a href="/" style={{ color: '#8ec3ff' }}>Missions</a>
            <a href="/audit" style={{ color: '#8ec3ff' }}>Audit</a>
            <a href="/health" style={{ color: '#8ec3ff' }}>Health</a>
            <a href="/intent-snapshots" style={{ color: '#8ec3ff' }}>Intent Snapshots</a>
            <a href="/knowledge" style={{ color: '#8ec3ff' }}>Knowledge</a>
          </nav>
          <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#9aa0aa' }}>
            tenant: <code style={{ color: scope ? '#9be3a8' : '#9aa0aa' }}>{scope ?? 'agnostic'}</code>
            {' · read-only'}
          </span>
        </header>
        <main style={{ maxWidth: '1080px', margin: '0 auto', padding: '24px' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
