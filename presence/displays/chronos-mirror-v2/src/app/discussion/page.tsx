import { redirect } from 'next/navigation';

// The discussion room lives inside the Chronos console (`/?section=discussion`).
// Keep the legacy `/discussion` URL as a redirect, forwarding goal/room/mission.
export default async function DiscussionPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams({ section: 'discussion' });
  const incoming = (await searchParams) ?? {};
  for (const key of ['goal', 'room', 'mission']) {
    const value = incoming[key];
    if (typeof value === 'string' && value) params.set(key, value);
  }
  redirect(`/?${params.toString()}`);
}
