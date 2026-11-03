'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { NavRail } from '@agent/shared-ui';

interface RailItem {
  id: string;
  label: string;
  hint: string;
  group_label: string;
  icon: string;
  href: string;
  external: boolean;
  path: string;
}

/** Which Chronos rail item the current `?section=` belongs to. */
export function chronosActiveRailItem(
  items: RailItem[],
  section: string | null
): string | undefined {
  if (!section) return undefined;
  return items.find((item) => !item.external && item.path.includes(`section=${section}`))?.id;
}

/**
 * The shared front-desk rail inside Chronos (`/api/front-desk/nav`), so the
 * person can move back to the shell (Inbox, Missions, Organization…) without
 * knowing ports. Renders nothing until the rail loads; a failed load keeps
 * Chronos usable on its own section tabs.
 */
export function ChronosFrontDeskRail({ locale }: { locale: string }) {
  const [payload, setPayload] = useState<{
    items: RailItem[];
    aria_label: string;
    brand_tagline: string;
  } | null>(null);
  const searchParams = useSearchParams();
  usePathname();
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/front-desk/nav?locale=${encodeURIComponent(locale)}`, {
      credentials: 'same-origin',
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body?.ok) setPayload(body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [locale]);
  if (!payload) return null;
  const active = chronosActiveRailItem(payload.items, searchParams.get('section'));
  return (
    <NavRail
      label={payload.aria_label}
      brand={{ name: 'Kyberion', subtitle: payload.brand_tagline }}
      items={payload.items.map((item) => ({
        id: item.id,
        label: item.label,
        hint: item.hint,
        href: item.href,
        icon: item.icon,
        group_label: item.group_label,
        active: item.id === active,
      }))}
    />
  );
}
