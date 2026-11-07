import {
  readFrontDeskSurfaceUrls,
  resolveFrontDeskDestination,
  type FrontDeskSurfaceId,
} from '@agent/core/front-desk-nav';
import type { HelpLinks } from '../../lib/help-view';

/**
 * Server-side: where the help page's shortcuts point. Pages still on
 * presence-studio (頼む, 進み具合) resolve through the shared destination
 * catalog, so they follow the surface manifest and switch to Concierge paths
 * as soon as those pages move — never a literal port.
 */
export function resolveHelpLinks(): HelpLinks {
  const urls = readFrontDeskSurfaceUrls() as Partial<Record<FrontDeskSurfaceId, string>>;
  const href = (id: string, fallback: string) =>
    resolveFrontDeskDestination(id, { currentSurface: 'concierge', urls })?.href ?? fallback;
  return {
    ask: href('ask', '/'),
    inbox: href('inbox', '/inbox'),
    progress: href('progress', '/work'),
    settings: href('settings', '/settings'),
    engine: '/settings#settings-engine',
  };
}
