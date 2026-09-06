import { describe, expect, it } from 'vitest';
import { isActuatorExampleCatalog, renderCatalogs } from './example_discovery.js';

describe('example discovery output', () => {
  it('renders an empty catalog without writing directly to stdout', () => {
    expect(renderCatalogs([])).toContain('No actuator-owned examples found.');
  });

  it('renders catalog entries deterministically', () => {
    expect(
      renderCatalogs([
        {
          actuator: 'browser',
          examples: [
            {
              id: 'open-page',
              title: 'Open page',
              path: 'libs/actuators/browser/examples/open-page.json',
              description: 'Open a page.',
            },
          ],
        },
      ])
    ).toContain('open-page: Open page');
  });

  it('ignores malformed catalog shapes instead of crashing discovery', () => {
    expect(isActuatorExampleCatalog([])).toBe(false);
    expect(isActuatorExampleCatalog({ actuator: 'browser', examples: [] })).toBe(true);
    expect(
      isActuatorExampleCatalog({
        actuator: 'browser',
        examples: [{ id: 'open-page', title: 'Open page' }],
      })
    ).toBe(false);
  });
});
