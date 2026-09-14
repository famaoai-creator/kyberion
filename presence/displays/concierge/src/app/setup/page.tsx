import { redirect } from 'next/navigation';

// FD-06: /setup is retired in favor of /settings. The browser keeps the
// `#hash` across a server redirect, and /settings keeps the same 8
// `#setup-…` section ids, so every existing deep link (the OAuth callback
// flow, the readiness checklist, the command palette, docs) still lands on
// the right card.
export default function SetupPage() {
  redirect('/settings');
}
