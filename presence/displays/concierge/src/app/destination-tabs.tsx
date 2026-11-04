'use client';

import * as React from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Tabs } from '@agent/shared-ui';
import { destinationTabHref } from '../lib/shell-scope';

/**
 * The tab row of a top-level destination (`/work`, `/org`, `/library`):
 * link tabs addressed by `?tab=`, so every tab is a shareable URL and the
 * browser back button walks the tabs.
 */
export function DestinationTabs<T extends string>({
  tabs,
  active,
  label,
}: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  label: string;
}) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const current = new URLSearchParams(searchParams?.toString() ?? '');
  const defaultTab = tabs[0]?.id;
  return (
    <Tabs
      label={label}
      active={active}
      items={tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        href: destinationTabHref(pathname, current, tab.id, defaultTab),
      }))}
    />
  );
}
