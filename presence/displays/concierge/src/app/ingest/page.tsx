import { redirect } from 'next/navigation';

/**
 * `/ingest` moved to 資料 › 資料の取込 (MSN-SHELL-IA §1). `proxy.ts` answers
 * with a 308 that keeps the query; this covers client-side navigations.
 */
export default async function IngestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      if (key !== 'tab') query.append(key, item);
    }
  }
  query.set('tab', 'ingest');
  redirect(`/library?${query.toString()}`);
}
