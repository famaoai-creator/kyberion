import { HelpPage } from './help-page';
import { resolveHelpLinks } from './help-links';

// Links follow the live surface manifest, so they are resolved per request.
export const dynamic = 'force-dynamic';

/** 使い方 (`/help`): training tracks and where things are. */
export default function Help() {
  return <HelpPage links={resolveHelpLinks()} trackId={null} />;
}
