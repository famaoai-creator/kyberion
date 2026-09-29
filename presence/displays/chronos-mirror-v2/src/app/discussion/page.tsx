import type { Metadata } from 'next';
import { DiscussionRoom } from '../../components/DiscussionRoom';

export const metadata: Metadata = {
  title: 'Discussion Room | Kyberion',
  description: 'Facilitated multi-agent discussion toward a goal',
};

export default function DiscussionPage() {
  return <DiscussionRoom />;
}
