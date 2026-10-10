import { PERSONAL_SELECTION, SYSTEM_SELECTION } from './tenant-context';

/** The server-validated selection `/api/me` reports (URL/cookie are only hints). */
export type RailSelection =
  | { mode: 'tenant'; tenant_slug: string }
  | { mode: 'personal'; aggregate?: boolean }
  | { mode: 'system' };

/** What `/api/me` says the viewer may switch to. */
export interface RailSwitcherPayload {
  personal: boolean;
  system: boolean;
  companies: Array<{ tenant_slug: string; display_name: string }>;
}

export interface RailSwitcherOption {
  value: string;
  label: string;
  selected: boolean;
}

/** The cookie/URL value that represents a selection. */
export function railSelectionValue(selection: RailSelection): string {
  if (selection.mode === 'tenant') return selection.tenant_slug;
  return selection.mode === 'system' ? SYSTEM_SELECTION : PERSONAL_SELECTION;
}

/**
 * The switcher's options: 個人, every allowed company, システム. The selected
 * company is always listed — even without a tenant profile — so the viewer can
 * always see where they are and switch away.
 */
export function railSwitcherOptions(
  selection: RailSelection,
  switcher: RailSwitcherPayload,
  labels: { personal: string; system: string }
): RailSwitcherOption[] {
  const selected = railSelectionValue(selection);
  const companies = [...switcher.companies];
  if (selection.mode === 'tenant' && !companies.some((c) => c.tenant_slug === selected)) {
    companies.push({ tenant_slug: selected, display_name: selected });
  }
  const options: RailSwitcherOption[] = [];
  if (switcher.personal || selection.mode === 'personal') {
    options.push({ value: PERSONAL_SELECTION, label: labels.personal, selected: false });
  }
  for (const company of companies) {
    options.push({
      value: company.tenant_slug,
      label: company.display_name || company.tenant_slug,
      selected: false,
    });
  }
  if (switcher.system || selection.mode === 'system') {
    options.push({ value: SYSTEM_SELECTION, label: labels.system, selected: false });
  }
  return options.map((option) => ({ ...option, selected: option.value === selected }));
}
