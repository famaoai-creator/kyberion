import type { MetadataRoute } from 'next';

/**
 * Installable concierge (phone home screen). The decision loop is the reason
 * this exists: a responsible human should be able to open "what needs me"
 * in one tap. `display: standalone` hides browser chrome; no offline data is
 * ever cached (see public/sw.js) — a stale decision is worse than none.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Kyberion Concierge',
    short_name: 'Concierge',
    description: 'Decisions, outcomes and exceptions that need you.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#1d4ed8',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
