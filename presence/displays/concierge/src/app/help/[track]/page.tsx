import { HelpPage } from '../help-page';
import { resolveHelpLinks } from '../help-links';
import { helpTrackId } from '../../../lib/help-view';

export const dynamic = 'force-dynamic';

/** 使い方 › one training track (`/help/<track>`). */
export default async function HelpTrackPage({ params }: { params: Promise<{ track: string }> }) {
  const { track } = await params;
  return <HelpPage links={resolveHelpLinks()} trackId={helpTrackId(track)} />;
}
