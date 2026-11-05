import { permanentRedirect } from 'next/navigation';

/**
 * MSN-SHELL-IA-20261105 §4: SSO lives in 設定 › 連携 (`/settings#settings-sso`).
 * The query is preserved, so the IdP link callback (`?linked=1`) still shows
 * its confirmation on the settings card.
 */
export default async function SsoSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value])
      query.append(key, entry);
  }
  const search = query.toString();
  permanentRedirect(`/settings${search ? `?${search}` : ''}#settings-sso`);
}
