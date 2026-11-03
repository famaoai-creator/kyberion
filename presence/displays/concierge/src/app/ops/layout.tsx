import * as React from 'react';
// The operations console stylesheet (Tailwind + the console rules, the former
// Chronos surface). postcss/ops-scope.cjs scopes every rule to `.kb-ops`, so
// it cannot restyle the Concierge shell that wraps this segment.
import './globals.css';

export const metadata = {
  title: 'Operations — Kyberion',
};

/** `/ops/*` — the operations console inside the Concierge shell (rail + header). */
export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return <div className="kb-ops">{children}</div>;
}
