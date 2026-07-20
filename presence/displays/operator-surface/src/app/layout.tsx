import * as React from 'react';
import { getTenantScope } from '@/lib/data';
import './globals.css';

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
          fontFamily: 'var(--kb-font-sans)',
          margin: 0,
          padding: 0,
          background: 'var(--kb-bg-main)',
          color: 'var(--kb-text-primary)',
        }}
      >
        <header
          style={{
            padding: '12px 24px',
            background: 'var(--kb-panel-bg)',
            borderBottom: '1px solid var(--kb-border)',
            display: 'flex',
            gap: '24px',
            alignItems: 'baseline',
          }}
        >
          <strong>Kyberion · Operator Surface</strong>
          <span
            title="このサーフェスの役割"
            style={{
              fontSize: '12px',
              padding: '2px 10px',
              borderRadius: '999px',
              border: '1px solid var(--kb-border)',
              color: 'var(--kb-text-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            監査モニタ（読み取り専用）
          </span>
          <nav style={{ display: 'flex', gap: '16px', fontSize: '14px' }}>
            <a href="/" style={{ color: 'var(--kb-accent)' }}>
              Missions
            </a>
            <a href="/audit" style={{ color: 'var(--kb-accent)' }}>
              Audit
            </a>
            <a href="/health" style={{ color: 'var(--kb-accent)' }}>
              Health
            </a>
            <a href="/reasoning" style={{ color: 'var(--kb-accent)' }}>
              Reasoning
            </a>
            <a href="/surfaces" style={{ color: 'var(--kb-accent)' }}>
              Surfaces
            </a>
            <a href="/intent-snapshots" style={{ color: 'var(--kb-accent)' }}>
              Intent Snapshots
            </a>
            <a href="/knowledge" style={{ color: 'var(--kb-accent)' }}>
              Knowledge
            </a>
          </nav>
          <span style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--kb-text-secondary)' }}>
            tenant:{' '}
            <code style={{ color: scope ? 'var(--kb-success)' : 'var(--kb-text-secondary)' }}>
              {scope ?? 'agnostic'}
            </code>
            {' · read-only'}
          </span>
        </header>
        <main style={{ maxWidth: '1080px', margin: '0 auto', padding: '24px' }}>{children}</main>
      </body>
    </html>
  );
}
