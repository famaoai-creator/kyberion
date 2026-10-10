import { describe, expect, it } from 'vitest';
import { railSelectionValue, railSwitcherOptions } from './rail-switcher';

const labels = { personal: 'Personal', system: 'System' };
const values = (options: ReturnType<typeof railSwitcherOptions>) =>
  options.map((option) => `${option.value}${option.selected ? '*' : ''}`);

describe('railSwitcherOptions', () => {
  it('lists personal, every company and system for an all-company viewer', () => {
    expect(
      values(
        railSwitcherOptions(
          { mode: 'system' },
          {
            personal: true,
            system: true,
            companies: [{ tenant_slug: 'acme', display_name: 'Acme' }],
          },
          labels
        )
      )
    ).toEqual(['personal', 'acme', 'shared*']);
  });

  it('keeps a selected company that the switcher payload does not list', () => {
    const options = railSwitcherOptions(
      { mode: 'tenant', tenant_slug: 'ghost' },
      { personal: true, system: false, companies: [{ tenant_slug: 'acme', display_name: 'Acme' }] },
      labels
    );
    expect(values(options)).toEqual(['personal', 'acme', 'ghost*']);
    expect(options[2].label).toBe('ghost');
  });

  it('gives a viewer scoped to one company a single option (no switcher)', () => {
    expect(
      railSwitcherOptions(
        { mode: 'tenant', tenant_slug: 'acme' },
        {
          personal: false,
          system: false,
          companies: [{ tenant_slug: 'acme', display_name: 'Acme' }],
        },
        labels
      )
    ).toEqual([{ value: 'acme', label: 'Acme', selected: true }]);
  });

  it('maps a selection to its cookie/URL value', () => {
    expect(railSelectionValue({ mode: 'tenant', tenant_slug: 'acme' })).toBe('acme');
    expect(railSelectionValue({ mode: 'personal' })).toBe('personal');
    expect(railSelectionValue({ mode: 'system' })).toBe('shared');
  });
});
