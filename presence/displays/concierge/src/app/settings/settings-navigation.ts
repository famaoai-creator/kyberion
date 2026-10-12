import type { SettingsSectionId } from '../../lib/settings-view';

export const SETTINGS_SECTION_ELEMENT_ID: Record<SettingsSectionId, string> = {
  profile: 'setup-profile',
  display: 'settings-display',
  members: 'settings-members',
  services: 'setup-services',
  voice: 'setup-media',
  notifications: 'setup-notifications',
  recording: 'settings-recording',
  plugins: 'setup-plugins',
  advanced: 'settings-advanced',
};

const TARGET_SECTIONS = new Map<string, SettingsSectionId>([
  ...Object.entries(SETTINGS_SECTION_ELEMENT_ID).map(
    ([section, id]) => [id, section as SettingsSectionId] as const
  ),
  ['setup-management', 'advanced'],
  ['setup-governance', 'advanced'],
  ['setup-operations', 'advanced'],
]);

export function resolveSettingsTarget(
  hash: string
): { id: string; section: SettingsSectionId } | null {
  if (!hash.startsWith('#')) return null;
  try {
    const id = decodeURIComponent(hash.slice(1));
    const section = TARGET_SECTIONS.get(id);
    return section ? { id, section } : null;
  } catch {
    return null;
  }
}

/** Compare all current positions, including Display nested within Profile. */
export function visibleSettingsSection(
  positions: Array<{ section: SettingsSectionId; top: number }>,
  anchor: number
): SettingsSectionId | null {
  const ordered = [...positions].sort((a, b) => a.top - b.top);
  return (
    ordered.filter((entry) => entry.top <= anchor).at(-1)?.section ?? ordered[0]?.section ?? null
  );
}

export function createSettingsNavigation(
  view: Window,
  document: Document,
  elements: Partial<Record<SettingsSectionId, HTMLElement | null>>,
  onSection: (section: SettingsSectionId) => void
) {
  let frame: number | null = null;
  let lastRestoredUrl: string | null = null;
  let anchor: string | null = null;
  let layoutObserver: ResizeObserver | null = null;
  const updateVisibleSection = () => {
    frame = null;
    const positions = Object.entries(SETTINGS_SECTION_ELEMENT_ID).flatMap(([section, id]) => {
      const element = elements[section as SettingsSectionId] ?? document.getElementById(id);
      return element && element.getClientRects().length
        ? [{ section: section as SettingsSectionId, top: element.getBoundingClientRect().top }]
        : [];
    });
    const section = visibleSettingsSection(positions, Math.min(160, view.innerHeight * 0.15));
    if (section) onSection(section);
  };
  const scheduleVisibleSection = () => {
    if (frame === null) frame = view.requestAnimationFrame(updateVisibleSection);
  };
  const reveal = (hash: string, focus: boolean): boolean => {
    const target = resolveSettingsTarget(hash);
    const element = target && document.getElementById(target.id);
    if (!target || !element) return false;
    let details = element.closest('details');
    while (details) {
      details.open = true;
      details = details.parentElement?.closest('details') ?? null;
    }
    // Immediate positioning avoids transient active sections and respects reduced motion.
    element.scrollIntoView({ behavior: 'auto', block: 'start' });
    onSection(target.section);
    if (focus) {
      if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
      element.focus({ preventScroll: true });
    }
    return true;
  };
  const stopTrackingAnchor = () => {
    anchor = null;
    layoutObserver?.disconnect();
    layoutObserver = null;
  };
  const trackAnchor = (hash: string) => {
    stopTrackingAnchor();
    if (!reveal(hash, false)) return;
    anchor = hash;
    // Independently loaded settings above the target can grow after setup itself
    // resolves. Follow those layout shifts only until the person takes control.
    const Observer = (view as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer && document.body) {
      layoutObserver = new Observer(() => {
        if (anchor) reveal(anchor, false);
      });
      layoutObserver.observe(document.body);
    }
  };
  const restore = (initial = false) => {
    if (lastRestoredUrl === view.location.href) return;
    lastRestoredUrl = view.location.href;
    stopTrackingAnchor();
    if (view.location.hash) trackAnchor(view.location.hash);
    else if (!initial) {
      view.scrollTo({ top: 0, behavior: 'auto' });
      updateVisibleSection();
    }
  };
  const replay = () => restore();
  view.addEventListener('hashchange', replay);
  view.addEventListener('popstate', replay);
  view.addEventListener('scroll', scheduleVisibleSection, { passive: true });
  view.addEventListener('resize', scheduleVisibleSection);
  const controlEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  controlEvents.forEach((event) =>
    view.addEventListener(event, stopTrackingAnchor, { passive: true, capture: true })
  );
  restore(true);
  if (!view.location.hash) updateVisibleSection();
  return {
    navigate(hash: string) {
      const target = resolveSettingsTarget(hash);
      if (!target || !document.getElementById(target.id)) return;
      const url = view.location.pathname + view.location.search + '#' + target.id;
      if (view.location.hash !== '#' + target.id)
        view.history.pushState(view.history.state, '', url);
      lastRestoredUrl = view.location.href;
      trackAnchor('#' + target.id);
      reveal('#' + target.id, true);
    },
    dispose() {
      stopTrackingAnchor();
      controlEvents.forEach((event) => view.removeEventListener(event, stopTrackingAnchor, true));
      view.removeEventListener('hashchange', replay);
      view.removeEventListener('popstate', replay);
      view.removeEventListener('scroll', scheduleVisibleSection);
      view.removeEventListener('resize', scheduleVisibleSection);
      if (frame !== null) view.cancelAnimationFrame(frame);
    },
  };
}
